import { describe, expect, it, vi } from "vitest";
import { CustomerPhoneIdentityService } from "./customer-phone-identity.service.js";

const phone = "13800138000";
const fixture = () => {
  const crypto = {
    hashPhoneVerification: vi.fn((_scope, value) => `hashed:${value}`),
    decrypt: vi.fn((value) => value.replace("encrypted:", "")),
    encrypt: vi.fn((value) => `encrypted:${value}`),
  };
  const tx = {
    $executeRaw: vi.fn(),
    customerPhoneIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: "legacy",
          status: "ACTIVE",
          phoneEncrypted: null,
          phoneVerifiedAt: null,
        }),
      update: vi.fn(),
    },
  };
  const service = new CustomerPhoneIdentityService(
    {} as never,
    crypto as never,
  );
  return { service, tx, crypto };
};

describe("CustomerPhoneIdentityService", () => {
  it("reuses a verified legacy user's exact ID and creates only an authentication registry row", async () => {
    const f = fixture();
    f.tx.user.findMany.mockResolvedValue([
      {
        id: "original-owner",
        phoneEncrypted: `encrypted:${phone}`,
        status: "ACTIVE",
      },
    ] as never);
    await expect(f.service.findOwner(f.tx as never, phone)).resolves.toBe(
      "original-owner",
    );
    expect(f.tx.customerPhoneIdentity.create).toHaveBeenCalledWith({
      data: { phoneHash: `hashed:${phone}`, userId: "original-owner" },
    });
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("refuses duplicate legacy owners without choosing one or moving assets", async () => {
    const f = fixture();
    f.tx.user.findMany.mockResolvedValue([
      {
        id: "wallet-owner",
        phoneEncrypted: `encrypted:${phone}`,
        status: "ACTIVE",
      },
      {
        id: "order-owner",
        phoneEncrypted: `encrypted:${phone}`,
        status: "ACTIVE",
      },
    ] as never);
    await expect(
      f.service.findOwner(f.tx as never, phone),
    ).rejects.toMatchObject({ response: { code: "ACCOUNT_LINK_CONFLICT" } });
    expect(f.tx.customerPhoneIdentity.create).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("fails closed for disabled owner or corrupt historical ciphertext", async () => {
    const f = fixture();
    f.tx.user.findMany.mockResolvedValue([
      {
        id: "disabled",
        phoneEncrypted: `encrypted:${phone}`,
        status: "SUSPENDED",
      },
    ] as never);
    await expect(f.service.findOwner(f.tx as never, phone)).rejects.toThrow(
      "不可用",
    );
    f.crypto.decrypt.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    await expect(f.service.findOwner(f.tx as never, phone)).rejects.toThrow(
      "历史手机号资料",
    );
  });
  it("validates existing registry against current verified phone instead of trusting a stale link", async () => {
    const f = fixture();
    f.tx.customerPhoneIdentity.findUnique.mockResolvedValue({
      userId: "legacy",
    } as never);
    f.tx.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      phoneEncrypted: "encrypted:13900139000",
      phoneVerifiedAt: new Date(),
    } as never);
    await expect(
      f.service.findOwner(f.tx as never, phone),
    ).rejects.toMatchObject({ response: { code: "ACCOUNT_LINK_CONFLICT" } });
    expect(f.tx.user.findMany).not.toHaveBeenCalled();
  });
  it("old phone-verification writes refuse a phone already owned by someone else", async () => {
    const f = fixture();
    f.tx.user.findMany.mockResolvedValue([
      { id: "another", phoneEncrypted: `encrypted:${phone}`, status: "ACTIVE" },
    ] as never);
    await expect(
      f.service.bindVerifiedPhone(f.tx as never, "legacy", phone, new Date()),
    ).rejects.toThrow("冲突");
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("never lets old verification replace a verified phone", async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValue({
      status: "ACTIVE",
      phoneEncrypted: "encrypted:13900139000",
      phoneVerifiedAt: new Date(),
    } as never);
    await expect(
      f.service.bindVerifiedPhone(f.tx as never, "legacy", phone, new Date()),
    ).rejects.toThrow("更换请联系人工客服");
    expect(f.tx.customerPhoneIdentity.create).not.toHaveBeenCalled();
  });
});

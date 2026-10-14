import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { WechatPayerResolver } from "./wechat-payer-resolver.service.js";

const principal: AuthPrincipal = {
  userId: "canonical-customer",
  sessionId: "session",
  displayName: "客户",
  memberships: [],
  authProvider: "wechat",
  authChannel: "WECHAT_MINIAPP",
  wechatIdentityId: "identity-b",
};
const identity = (id = "identity-b", openId = "openid-b") => ({
  id,
  userId: principal.userId,
  provider: "WECHAT_MINIAPP",
  subjectEncrypted: openId,
  subjectHash: `app:${openId}`,
});
function fixture() {
  const identities = [identity("identity-a", "openid-a"), identity()];
  const prisma = {
    externalIdentity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        identities.find((value) => value.id === where.id),
      ),
      findMany: vi.fn(async () => identities),
    },
  };
  const crypto = {
    decrypt: vi.fn((value: string) => value),
    hashIdentity: vi.fn((_app: string, value: string) => `app:${value}`),
  };
  const config = { get: vi.fn(() => "current-app") };
  return {
    resolver: new WechatPayerResolver(
      prisma as never,
      config as never,
      crypto as never,
    ),
    prisma,
    crypto,
    identities,
  };
}

describe("session-bound canonical customer WeChat payer", () => {
  it("uses only the authenticating identity when a phone account has multiple WeChat bindings", async () => {
    const f = fixture();
    await expect(f.resolver.resolveOpenId(principal)).resolves.toBe("openid-b");
    expect(f.prisma.externalIdentity.findUnique).toHaveBeenCalledWith({
      where: { id: "identity-b" },
    });
    expect(f.prisma.externalIdentity.findMany).not.toHaveBeenCalled();
    expect(f.crypto.decrypt).toHaveBeenCalledTimes(1);
  });
  it.each([
    { authProvider: "customer-sms", authChannel: "CUSTOMER_SMS" },
    { authProvider: "wechat", authChannel: "CUSTOMER_SMS" },
    { authProvider: "staff-password", authChannel: "ADMIN_BROWSER" },
    { authProvider: "wechat", authChannel: "WECHAT_H5" },
    { authProvider: "mock", authChannel: "WECHAT_MINIAPP" },
    { authProvider: undefined, authChannel: undefined },
  ])("never borrows old WeChat identities for %j", async (fields) => {
    const f = fixture();
    await expect(
      f.resolver.resolveOpenId({ ...principal, ...fields }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.externalIdentity.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.externalIdentity.findMany).not.toHaveBeenCalled();
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
  });
  it.each(["owner", "provider", "app", "cipher", "mock", "missing"])(
    "fails closed for a session identity with wrong %s",
    async (kind) => {
      const f = fixture();
      const selected = f.identities[1]!;
      if (kind === "owner") selected.userId = "another-customer";
      if (kind === "provider") selected.provider = "WECHAT_H5";
      if (kind === "app") selected.subjectHash = "another-app:openid-b";
      if (kind === "cipher")
        f.crypto.decrypt.mockImplementation(() => {
          throw Error("private encryption detail");
        });
      if (kind === "mock") selected.subjectEncrypted = "mock-customer";
      if (kind === "missing") f.identities.pop();
      await expect(f.resolver.resolveOpenId(principal)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.prisma.externalIdentity.findMany).not.toHaveBeenCalled();
    },
  );
  it("retains a legacy session only with one valid current-app identity", async () => {
    const f = fixture();
    f.identities.splice(0, 1);
    await expect(
      f.resolver.resolveOpenId({ ...principal, wechatIdentityId: null }),
    ).resolves.toBe("openid-b");
    expect(f.prisma.externalIdentity.findMany).toHaveBeenCalledWith({
      where: { userId: principal.userId, provider: "WECHAT_MINIAPP" },
    });
  });
  it("refuses ambiguous legacy sessions rather than arbitrary first identity or bounded prefix", async () => {
    const f = fixture();
    await expect(
      f.resolver.resolveOpenId({ ...principal, wechatIdentityId: null }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("ignores other-app bindings in legacy uniqueness without ever returning them", async () => {
    const f = fixture();
    f.identities[0]!.subjectHash = "another-app:openid-a";
    await expect(
      f.resolver.resolveOpenId({ ...principal, wechatIdentityId: null }),
    ).resolves.toBe("openid-b");
  });
});

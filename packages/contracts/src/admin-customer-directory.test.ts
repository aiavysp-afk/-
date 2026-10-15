import { describe, expect, it } from "vitest";
import {
  AdminCustomerDirectoryQuerySchema,
  AdminCustomerDirectorySchema,
  AdminCustomerPhoneRevealRequestSchema,
  AdminCustomerPhoneRevealSchema,
} from "./index.js";

describe("organization customer directory contracts", () => {
  it("bounds pages and accepts only opaque cursor pagination", () => {
    expect(AdminCustomerDirectoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      AdminCustomerDirectoryQuerySchema.parse({
        limit: "50",
        cursor: "user_2",
      }),
    ).toEqual({ limit: 50, cursor: "user_2" });
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.2 },
      { limit: "all" },
      { cursor: "../other" },
      { phone: "13800138000" },
      { organizationId: "forged" },
      { includeFullPhone: true },
    ])
      expect(AdminCustomerDirectoryQuerySchema.safeParse(query).success).toBe(
        false,
      );
  });

  it("never allows a full or encrypted phone in the default list contract", () => {
    const item = {
      userId: "customer",
      displayName: "客户",
      maskedPhone: "138****8000",
      phoneVerified: true,
      createdAt: "2026-10-15T10:00:00.000Z",
    };
    const value = { items: [item], nextCursor: null };
    expect(AdminCustomerDirectorySchema.parse(value)).toEqual(value);
    for (const extra of [
      { maskedPhone: "13800138000" },
      { phone: "13800138000" },
      { phoneEncrypted: "ciphertext" },
      { identities: [] },
    ])
      expect(
        AdminCustomerDirectorySchema.safeParse({
          ...value,
          items: [{ ...item, ...extra }],
        }).success,
      ).toBe(false);
  });

  it("requires an explicit bounded purpose without identity or MFA override fields", () => {
    expect(
      AdminCustomerPhoneRevealRequestSchema.parse({
        reason: "  核对预约联系  ",
      }),
    ).toEqual({ reason: "核对预约联系" });
    for (const body of [
      {},
      { reason: "" },
      { reason: "查询" },
      { reason: "x".repeat(201) },
      { reason: "核对\u0000预约联系" },
      { reason: "核对预约联系", mfaVerified: true },
      { reason: "核对预约联系", organizationId: "other" },
      { reason: "核对预约联系", phone: "13800138000" },
    ])
      expect(
        AdminCustomerPhoneRevealRequestSchema.safeParse(body).success,
      ).toBe(false);
  });

  it("limits reveal responses to a verified mobile and a display expiry", () => {
    expect(
      AdminCustomerPhoneRevealSchema.safeParse({
        userId: "customer",
        phone: "13800138000",
        expiresAt: "2026-10-15T10:01:00.000Z",
      }).success,
    ).toBe(true);
    for (const value of [
      {
        userId: "customer",
        phone: "138****8000",
        expiresAt: "2026-10-15T10:01:00.000Z",
      },
      { userId: "customer", phone: "13800138000" },
    ])
      expect(AdminCustomerPhoneRevealSchema.safeParse(value).success).toBe(
        false,
      );
  });
});

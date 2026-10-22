import { describe, expect, it } from "vitest";
import {
  TechnicianPhoneLoginCapabilitiesSchema,
  TechnicianPhoneProfileDraftSchema,
  TechnicianH5ProfileUpdateSchema,
  TechnicianPhoneSmsConfirmSchema,
  TechnicianPhoneSmsRequestSchema,
  TechnicianPhoneSmsRequestResultSchema,
  TechnicianApplicationSchema,
} from "./index.js";
const request = { phone: "13800138000", agreementsAccepted: true };
const proof = {
  challengeId: "d5a706b9-6449-42ba-9ab6-a321bdf60688",
  challengeSecret: "a".repeat(43),
};
describe("technician phone login contracts", () => {
  it("exposes only enabled gates, no key/configuration material", () => {
    expect(
      TechnicianPhoneLoginCapabilitiesSchema.parse({
        enabled: false,
        workbenchEnabled: false,
      }),
    ).toEqual({ enabled: false, workbenchEnabled: false });
  });
  it("requires accepted agreements and rejects injected source/user/tenant/privilege", () => {
    expect(TechnicianPhoneSmsRequestSchema.safeParse(request).success).toBe(
      true,
    );
    for (const extra of [
      { agreementsAccepted: false },
      { userId: "other" },
      { role: "THERAPIST" },
      { authChannel: "ADMIN_BROWSER" },
      { organizationId: "other" },
      { ip: "forged" },
    ])
      expect(
        TechnicianPhoneSmsRequestSchema.safeParse({ ...request, ...extra })
          .success,
      ).toBe(false);
  });
  it("requires UUID+strong browser proof and six-digit SMS, distinct from OTP-only login", () => {
    const confirm = { ...request, ...proof, code: "123456" };
    expect(TechnicianPhoneSmsConfirmSchema.safeParse(confirm).success).toBe(
      true,
    );
    for (const extra of [
      { challengeSecret: undefined },
      { challengeSecret: "short" },
      { challengeId: "short" },
      { code: "12345" },
      { purpose: "staff-password" },
    ])
      expect(
        TechnicianPhoneSmsConfirmSchema.safeParse({ ...confirm, ...extra })
          .success,
      ).toBe(false);
    expect(
      TechnicianPhoneSmsRequestResultSchema.safeParse({
        ...proof,
        maskedPhone: "138****8000",
        expiresAt: new Date().toISOString(),
        retryAfterSeconds: 60,
      }).success,
    ).toBe(true);
  });
  it("incomplete drafts save but never satisfy final submission; untrusted image URL/state cannot be set", () => {
    const partial = { realName: "", bio: "先存", serviceIds: [] };
    expect(TechnicianPhoneProfileDraftSchema.safeParse(partial).success).toBe(
      true,
    );
    expect(TechnicianH5ProfileUpdateSchema.safeParse(partial).success).toBe(
      false,
    );
    for (const extra of [
      { status: "APPROVED" },
      { avatarUrl: "https://fixture.invalid/id.jpg" },
      { realNameEncrypted: "fake" },
      { organizationId: "other" },
    ])
      expect(
        TechnicianPhoneProfileDraftSchema.safeParse({ ...partial, ...extra })
          .success,
      ).toBe(false);
  });
  it("accepts the explicit phone registration source for existing organization-scoped application records", () => {
    expect(
      TechnicianApplicationSchema.shape.registrationChannel.safeParse(
        "TECHNICIAN_PHONE",
      ).success,
    ).toBe(true);
    expect(
      TechnicianApplicationSchema.shape.registrationChannel.safeParse(
        "ADMIN_BROWSER",
      ).success,
    ).toBe(false);
  });
});

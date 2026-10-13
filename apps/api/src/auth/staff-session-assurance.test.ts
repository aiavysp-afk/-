import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service.js";

function fixture(method = "PASSWORD_SMS", provider = "staff-password", enabled = "true") {
  const expiresAt = new Date(Date.now() + 3_600_000);
  const session = {
    id: "session", userId: "operator", revokedAt: null, expiresAt,
    authChannel: "ADMIN_BROWSER", authProvider: provider,
    mfaVerifiedUntil: null as Date | null,
    staffVerifiedUntil: expiresAt, staffVerificationMethod: method,
    staffPasswordVersion: 1, trustedDeviceId: "device",
    user: { id: "operator", status: "ACTIVE", displayName: "fixture", phoneEncrypted: "encrypted", phoneVerifiedAt: new Date(), memberships: [{ organizationId: "org-a", role: "OPERATOR" }] },
  };
  const credential = { version: 1, phoneHash: "phone-hash" };
  const prisma = { session: { findUnique: vi.fn().mockResolvedValue(session), update: vi.fn() }, staffPasswordCredential: { findUnique: vi.fn().mockResolvedValue(credential) } };
  const crypto = { hashSessionToken: () => "token-hash", hashPhoneVerification: () => "phone-hash", decrypt: () => "13800138000" };
  const trust = { validateSessionTrust: vi.fn().mockResolvedValue(true) };
  const auth = new AuthService(prisma as never, crypto as never, {} as never, new ConfigService({ STAFF_PASSWORD_LOGIN_ENABLED: enabled }) as never, trust as never);
  return { auth, session, credential, trust, prisma, crypto };
}

describe("server-derived browser login assurance", () => {
  it("accepts password+SMS assurance without inventing a fresh TOTP grant", async () => {
    const { auth, session } = fixture();
    const actor = await auth.authenticate("x".repeat(43));
    expect(actor.staffVerifiedUntil).toEqual(session.expiresAt);
    expect(actor.staffVerificationMethod).toBe("PASSWORD_SMS");
    expect(actor.mfaVerifiedUntil).toBeNull();
    expect(actor.trustedDeviceId).toBeNull();
  });
  it.each(["version", "phone", "disabled", "role"])("invalidates password sessions after %s changes", async (change) => {
    const f = fixture("PASSWORD_SMS", "staff-password", change === "disabled" ? "false" : "true");
    if (change === "version") f.credential.version = 2;
    if (change === "phone") f.credential.phoneHash = "new-phone";
    if (change === "role") f.session.user.memberships = [];
    await expect(f.auth.authenticate("x".repeat(43))).rejects.toThrow(/重新登录|重新登录|微信重新登录/);
  });
  it("revalidates device authority on every request and drops revoked assurance", async () => {
    const f = fixture("TRUSTED_DEVICE", "wechat");
    const fresh = new Date(Date.now() + 30_000);
    f.session.mfaVerifiedUntil = fresh;
    const first = await f.auth.authenticate("x".repeat(43));
    expect(first.staffVerificationMethod).toBe("TRUSTED_DEVICE");
    expect(first.trustedDeviceId).toBe("device");
    f.trust.validateSessionTrust.mockResolvedValue(false);
    const revoked = await f.auth.authenticate("x".repeat(43));
    expect(revoked.staffVerifiedUntil).toBeNull();
    expect(revoked.staffVerificationMethod).toBeNull();
    expect(revoked.mfaVerifiedUntil).toEqual(fresh);
    expect(f.trust.validateSessionTrust).toHaveBeenCalledTimes(2);
  });
  it("keeps WeChat trusted-device login independent of the password+SMS rollout flag", async () => {
    const f = fixture("TRUSTED_DEVICE", "wechat", "false");
    const actor = await f.auth.authenticate("x".repeat(43));
    expect(actor.staffVerificationMethod).toBe("TRUSTED_DEVICE");
    expect(actor.staffVerifiedUntil).toEqual(f.session.expiresAt);
    expect(actor.mfaVerifiedUntil).toBeNull();
    expect(f.prisma.staffPasswordCredential.findUnique).not.toHaveBeenCalled();
    expect(f.trust.validateSessionTrust).toHaveBeenCalledTimes(1);
  });
  it("does not accept a PASSWORD_SMS label on a WeChat session or unknown labels", async () => {
    expect((await fixture("PASSWORD_SMS", "wechat").auth.authenticate("x".repeat(43))).staffVerifiedUntil).toBeNull();
    expect((await fixture("client-checkbox", "wechat").auth.authenticate("x".repeat(43))).staffVerifiedUntil).toBeNull();
  });
});

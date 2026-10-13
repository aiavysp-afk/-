import { describe, expect, it, vi } from "vitest";
import type { AuthSession, AuthUser } from "@zydj/contracts";
import {
  createLoginGeneration,
  deliverBrowserSession,
  hasFreshTotp,
  managementOrganizationId,
} from "./login-state";

const session: AuthSession = {
  accessToken: "isolated-test-token",
  expiresAt: "2026-10-14T08:00:00.000Z",
  user: {
    id: "test-staff",
    displayName: "工作人员",
    phoneVerified: true,
    memberships: [{ organizationId: "operations", role: "OPERATOR" }],
  },
};

describe("admin login generation and real server device trust", () => {
  it("invalidates the old request even when switching back to the same method", () => {
    const generation = createLoginGeneration();
    const wechat = generation.begin();
    generation.invalidate();
    const password = generation.begin();
    generation.invalidate();
    const nextWechat = generation.begin();
    expect(wechat()).toBe(false);
    expect(password()).toBe(false);
    expect(nextWechat()).toBe(true);
  });

  it("revokes a late first-factor session without delivering it or accepting a trust cookie", async () => {
    const generation = createLoginGeneration();
    const isCurrent = generation.begin();
    generation.invalidate();
    const accept = vi.fn(async () => ({ trusted: true }));
    const revoke = vi.fn(async () => undefined);
    const onSession = vi.fn();
    expect(
      await deliverBrowserSession(
        session,
        isCurrent,
        accept,
        revoke,
        onSession,
      ),
    ).toBe(false);
    expect(revoke).toHaveBeenCalledWith(session);
    expect(accept).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
  });

  it("revokes a late session when the user switches while the trust response is in flight", async () => {
    const generation = createLoginGeneration();
    const isCurrent = generation.begin();
    let finishTrust!: () => void;
    const accept = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTrust = resolve;
        }),
    );
    const revoke = vi.fn(async () => undefined);
    const onSession = vi.fn();
    const delivered = deliverBrowserSession(
      session,
      isCurrent,
      accept,
      revoke,
      onSession,
    );
    generation.invalidate();
    finishTrust();
    expect(await delivered).toBe(false);
    expect(revoke).toHaveBeenCalledOnce();
    expect(onSession).not.toHaveBeenCalled();
  });

  it("continues ordinary MFA when trust is disabled, with no local verification substitution", async () => {
    const onSession = vi.fn();
    const revoke = vi.fn(async () => undefined);
    expect(
      await deliverBrowserSession(
        session,
        () => true,
        async () => ({ trusted: false }),
        revoke,
        onSession,
      ),
    ).toBe(true);
    expect(onSession).toHaveBeenCalledWith(session);
    expect(revoke).not.toHaveBeenCalled();
    expect(session).not.toHaveProperty("mfaVerifiedUntil");
  });

  it("falls back to ordinary MFA on a failed trust endpoint rather than losing the identity session", async () => {
    const onSession = vi.fn();
    expect(
      await deliverBrowserSession(
        session,
        () => true,
        async () => {
          throw Error("network unavailable");
        },
        async () => undefined,
        onSession,
      ),
    ).toBe(true);
    expect(onSession).toHaveBeenCalledWith(session);
  });
});

describe("fresh TOTP remains separate from 7-day login proof", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  it("does not unlock password, device registration or approval on SMS or device proof", () => {
    const status = {
      verifiedUntil: null,
      loginVerifiedUntil: "2026-10-21T00:00:00.000Z",
      loginMethod: "TRUSTED_DEVICE",
    };
    expect(hasFreshTotp(status, now)).toBe(false);
    const smsStatus = { ...status, loginMethod: "SMS" };
    expect(hasFreshTotp(smsStatus, now)).toBe(false);
  });
  it("requires a future dynamic-code expiry, not an expired, exact-now or malformed date", () => {
    expect(
      hasFreshTotp({ verifiedUntil: "2026-10-14T00:05:00.000Z" }, now),
    ).toBe(true);
    expect(
      hasFreshTotp({ verifiedUntil: "2026-10-14T00:00:00.000Z" }, now),
    ).toBe(false);
    expect(
      hasFreshTotp({ verifiedUntil: "2026-10-13T23:59:59.000Z" }, now),
    ).toBe(false);
    expect(hasFreshTotp({ verifiedUntil: "not a date" }, now)).toBe(false);
    expect(hasFreshTotp(null, now)).toBe(false);
  });
});

describe("management organization selection", () => {
  it("selects the actual staff membership when the same WeChat also owns a technician membership", () => {
    const user: AuthUser = {
      ...session.user,
      memberships: [
        { organizationId: "technician-organization", role: "THERAPIST" },
        { organizationId: "operations", role: "OPERATOR" },
      ],
    };
    expect(managementOrganizationId(user)).toBe("operations");
    expect(user.memberships[0]!.role).toBe("THERAPIST");
  });
  it("does not invent a management organization for a customer or technician", () => {
    expect(
      managementOrganizationId({
        ...session.user,
        memberships: [{ organizationId: "tech", role: "THERAPIST" }],
      }),
    ).toBe("");
    expect(managementOrganizationId({ ...session.user, memberships: [] })).toBe(
      "",
    );
  });
});

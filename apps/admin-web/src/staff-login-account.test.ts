import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStaffPasswordUpdate,
  currentStaffPasswordChallenge,
  isValidStaffLoginAccount,
  isValidStaffLoginAlias,
  normalizeStaffLoginAccount,
  normalizeStaffLoginAlias,
} from "./staff-login-account";
import { createLoginGeneration, deliverBrowserSession } from "./login-state";
import type { AuthSession } from "@zydj/contracts";

afterEach(() => vi.unstubAllGlobals());

const now = Date.parse("2026-10-16T10:00:00Z");
const draft = {
  loginAlias: " ADMIN ",
  password: "synthetic-password-42",
  confirmation: "synthetic-password-42",
};
const authorization = {
  enabled: true,
  maskedAccount: "138****8000",
  verifiedUntil: "2026-10-16T10:05:00Z",
  busy: false,
};

describe("staff usernames preserve existing phone login", () => {
  it("preserves admin as a username instead of stripping its letters", () => {
    expect(normalizeStaffLoginAccount("admin")).toBe("admin");
    expect(normalizeStaffLoginAccount("  ADMIN ")).toBe("admin");
    expect(normalizeStaffLoginAlias("  ADMIN ")).toBe("admin");
    expect(isValidStaffLoginAccount("admin")).toBe(true);
    expect(isValidStaffLoginAlias("admin")).toBe(true);
  });

  it("continues accepting bound mobile numbers without interpreting them as usernames", () => {
    expect(normalizeStaffLoginAccount(" 13800138000 ")).toBe("13800138000");
    expect(isValidStaffLoginAccount("13800138000")).toBe(true);
    expect(isValidStaffLoginAlias("13800138000")).toBe(false);
  });

  it("uses the exact normalized 4–32 letter-first alias format", () => {
    for (const value of ["a123", "admin_01", "admin-01", "A".repeat(32)]) {
      expect(isValidStaffLoginAlias(value), value).toBe(true);
      expect(isValidStaffLoginAccount(value), value).toBe(true);
    }
    for (const value of [
      "",
      "adm",
      "a".repeat(33),
      "1admin",
      "_admin",
      "ad min",
      "admin@example.com",
      "管理员",
      "admin\u0000test",
      "01234567890",
      "+8613800138000",
    ]) {
      expect(isValidStaffLoginAccount(value), value).toBe(false);
    }
  });
});

describe("self-service username and new-password submission", () => {
  it("builds only normalized alias and person-supplied password, never a user/phone/role override", () => {
    expect(buildStaffPasswordUpdate(draft, authorization, now)).toEqual({
      loginAlias: "admin",
      password: draft.password,
    });
  });

  it("does not save without a fresh dynamic code even if SMS/trusted-device login is active", () => {
    for (const verifiedUntil of [
      null,
      "invalid",
      "2026-10-16T09:59:00Z",
      "2026-10-16T10:00:00Z",
    ]) {
      expect(
        buildStaffPasswordUpdate(
          draft,
          { ...authorization, verifiedUntil },
          now,
        ),
      ).toBeNull();
    }
    expect(
      buildStaffPasswordUpdate(
        draft,
        { ...authorization, enabled: false },
        now,
      ),
    ).toBeNull();
    expect(
      buildStaffPasswordUpdate(draft, { ...authorization, busy: true }, now),
    ).toBeNull();
    expect(
      buildStaffPasswordUpdate(
        draft,
        { ...authorization, maskedAccount: null },
        now,
      ),
    ).toBeNull();
  });

  it("requires 12–128 matching password characters and a valid nonempty alias", () => {
    for (const size of [12, 128]) {
      const password = "x".repeat(size);
      expect(
        buildStaffPasswordUpdate(
          { ...draft, password, confirmation: password },
          authorization,
          now,
        ),
      ).not.toBeNull();
    }
    for (const size of [0, 11, 129]) {
      const password = "x".repeat(size);
      expect(
        buildStaffPasswordUpdate(
          { ...draft, password, confirmation: password },
          authorization,
          now,
        ),
      ).toBeNull();
    }
    expect(
      buildStaffPasswordUpdate(
        { ...draft, confirmation: "different-value" },
        authorization,
        now,
      ),
    ).toBeNull();
    expect(
      buildStaffPasswordUpdate(
        { ...draft, loginAlias: "" },
        authorization,
        now,
      ),
    ).toBeNull();
  });

  it("has no browser-persistence side effect for passwords or confirmation", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("sessionStorage", { setItem });
    buildStaffPasswordUpdate(draft, authorization, now);
    expect(setItem).not.toHaveBeenCalled();
    expect(draft).toEqual({
      loginAlias: " ADMIN ",
      password: "synthetic-password-42",
      confirmation: "synthetic-password-42",
    });
  });
});

describe("account-switch in-flight isolation", () => {
  it("does not show account A's late SMS challenge after entering account B", async () => {
    const generations = createLoginGeneration();
    const accountA = generations.begin();
    let resolveA!: (value: { maskedPhone: string }) => void;
    const response = new Promise<{ maskedPhone: string }>((resolve) => {
      resolveA = resolve;
    });
    const pending = currentStaffPasswordChallenge(() => response, accountA);
    generations.invalidate(); // BrowserLogin account/method edit invalidates its attempt.
    const accountB = generations.begin();
    resolveA({ maskedPhone: "138****8000" });
    await expect(pending).resolves.toBeNull();
    expect(accountB()).toBe(true);
  });

  it("delivers only a current account's successful challenge", async () => {
    const generations = createLoginGeneration();
    const challenge = {
      challengeId: "synthetic-challenge",
      maskedPhone: "138****8000",
    };
    await expect(
      currentStaffPasswordChallenge(async () => challenge, generations.begin()),
    ).resolves.toEqual(challenge);
  });

  it("revokes a late logged-in session rather than logging the newly selected account in", async () => {
    const generations = createLoginGeneration();
    const previous = generations.begin();
    generations.invalidate();
    const onSession = vi.fn();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const acceptTrust = vi.fn();
    const session = { accessToken: "synthetic-previous-token" } as AuthSession;
    await expect(
      deliverBrowserSession(session, previous, acceptTrust, revoke, onSession),
    ).resolves.toBe(false);
    expect(revoke).toHaveBeenCalledWith(session);
    expect(acceptTrust).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
  });
});

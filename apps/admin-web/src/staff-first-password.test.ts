import { describe, expect, it } from "vitest";
import {
  buildStaffSetupConfirmation,
  isValidStaffSetupPhone,
  normalizeStaffSetupPhone,
  parseStaffSetupChallenge,
} from "./staff-first-password";

const challenge = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: "s".repeat(43),
  maskedPhone: "138****8000",
  expiresAt: "2026-01-01T00:00:00.000Z",
  retryAfterSeconds: 60,
};
const draft = {
  code: "000001",
  loginAlias: "  Admin_01  ",
  password: "synthetic-password-42",
  confirmation: "synthetic-password-42",
};
describe("first password setup input boundary", () => {
  it("accepts only a complete mainland phone number and trims without inventing a number", () => {
    expect(normalizeStaffSetupPhone(" 13800138000 ")).toBe("13800138000");
    expect(isValidStaffSetupPhone(" 13800138000 ")).toBe(true);
    for (const phone of [
      "",
      "+8613800138000",
      "138****8000",
      "138 0013 8000",
      "10000138000",
    ])
      expect(isValidStaffSetupPhone(phone)).toBe(false);
  });
  it("accepts parseable server time independently of workstation expiry guesses and strips extra fields", () => {
    expect(
      parseStaffSetupChallenge({
        ...challenge,
        ignored: "never reflect upstream extras",
      }),
    ).toEqual(challenge);
  });
  it.each([
    { challengeId: "invalid" },
    { challengeSecret: "short" },
    { maskedPhone: "13800138000" },
    { maskedPhone: "private-content" },
    { expiresAt: "invalid" },
    { retryAfterSeconds: 0 },
    { retryAfterSeconds: 60.5 },
    { retryAfterSeconds: 3601 },
  ])(
    "rejects malformed or unmasked challenge fields without returning any secret (%j)",
    (change) => {
      expect(parseStaffSetupChallenge({ ...challenge, ...change })).toBeNull();
    },
  );
  it("builds only the explicitly confirmed, normalized payload without phone or password confirmation", () => {
    expect(buildStaffSetupConfirmation(challenge, draft)).toEqual({
      challengeId: challenge.challengeId,
      challengeSecret: challenge.challengeSecret,
      code: "000001",
      loginAlias: "admin_01",
      password: draft.password,
    });
    expect(draft.loginAlias).toBe("  Admin_01  ");
  });
  it.each([
    { code: "123" },
    { loginAlias: "bad alias" },
    { password: "short", confirmation: "short" },
    { password: "p".repeat(129), confirmation: "p".repeat(129) },
    { confirmation: "does-not-match" },
  ])(
    "does not build an invalid or unconfirmed password mutation (%j)",
    (change) => {
      expect(
        buildStaffSetupConfirmation(challenge, { ...draft, ...change }),
      ).toBeNull();
    },
  );
  it("requires a valid challenge before building a confirmation", () => {
    expect(buildStaffSetupConfirmation(null, draft)).toBeNull();
  });
});

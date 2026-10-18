import { describe, expect, it } from "vitest";
import {
  buildStaffSetupConfirmation,
  getStaffSetupDraftIssues,
  isValidStaffSetupPhone,
  normalizeStaffSetupPhone,
  parseStaffSetupChallenge,
  type StaffSetupDraft,
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
  it("reports all pending fields using static guidance, without reflecting supplied values", () => {
    const invalid = {
      code: "123",
      loginAlias: "synthetic-invalid@alias",
      password: "shrt-key",
      confirmation: "synthetic-confirmation",
    };
    const issues = getStaffSetupDraftIssues(invalid);
    expect(issues.code).toContain("6位短信验证码");
    expect(issues.loginAlias).toContain("不能直接填写手机号或中文");
    expect(issues.password).toContain("12–128");
    expect(issues.confirmation).toContain("不一致");
    for (const supplied of Object.values(invalid))
      expect(JSON.stringify(issues)).not.toContain(supplied);
    expect(
      getStaffSetupDraftIssues({
        code: "",
        loginAlias: "",
        password: "",
        confirmation: "",
      }),
    ).toEqual({
      code: expect.any(String),
      loginAlias: expect.any(String),
      password: expect.any(String),
      confirmation: expect.any(String),
    });
  });
  it.each<{ field: keyof StaffSetupDraft; value: string }>([
    { field: "code", value: "" },
    { field: "code", value: "12345" },
    { field: "code", value: " 000001 " },
    { field: "loginAlias", value: "13800138000" },
    { field: "loginAlias", value: "管理员" },
    { field: "loginAlias", value: "adm" },
    { field: "loginAlias", value: "a".repeat(33) },
    { field: "password", value: "p".repeat(11) },
    { field: "password", value: "p".repeat(129) },
    { field: "confirmation", value: "" },
    { field: "confirmation", value: "not-the-same-password" },
  ])(
    "keeps $field feedback and confirmation validity in sync",
    ({ field, value }) => {
      const supplied = { ...draft, [field]: value };
      expect(getStaffSetupDraftIssues(supplied)[field]).toEqual(
        expect.any(String),
      );
      expect(buildStaffSetupConfirmation(challenge, supplied)).toBeNull();
    },
  );
  it.each([12, 128])(
    "retains password boundary %i and server-owned challenge expiry",
    (length) => {
      const supplied = {
        ...draft,
        password: "p".repeat(length),
        confirmation: "p".repeat(length),
      };
      expect(
        Object.values(getStaffSetupDraftIssues(supplied)).every(
          (issue) => issue === null,
        ),
      ).toBe(true);
      expect(buildStaffSetupConfirmation(challenge, supplied)?.password).toBe(
        supplied.password,
      );
    },
  );
});

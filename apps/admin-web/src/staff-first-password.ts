import {
  isValidStaffLoginAlias,
  normalizeStaffLoginAlias,
} from "./staff-login-account";

export const normalizeStaffSetupPhone = (phone: string) => phone.trim();
export const isValidStaffSetupPhone = (phone: string) =>
  /^1[3-9]\d{9}$/.test(normalizeStaffSetupPhone(phone));

export type StaffSetupChallenge = {
  challengeId: string;
  challengeSecret: string;
  maskedPhone: string;
  expiresAt: string;
  retryAfterSeconds: number;
};
export type StaffSetupDraft = {
  code: string;
  loginAlias: string;
  password: string;
  confirmation: string;
};

export function parseStaffSetupChallenge(
  value: unknown,
): StaffSetupChallenge | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.challengeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.challengeId,
    ) ||
    typeof row.challengeSecret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.challengeSecret) ||
    typeof row.maskedPhone !== "string" ||
    !/^1[3-9]\d\*{4}\d{4}$/.test(row.maskedPhone) ||
    typeof row.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(row.expiresAt) ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    typeof row.retryAfterSeconds !== "number" ||
    !Number.isInteger(row.retryAfterSeconds) ||
    row.retryAfterSeconds < 1 ||
    row.retryAfterSeconds > 3600
  )
    return null;
  // Whitelist only the required proof. Never reflect extra upstream fields or
  // reject server-valid challenges just because the workstation clock is skewed.
  return {
    challengeId: row.challengeId,
    challengeSecret: row.challengeSecret,
    maskedPhone: row.maskedPhone,
    expiresAt: row.expiresAt,
    retryAfterSeconds: row.retryAfterSeconds,
  };
}

export function buildStaffSetupConfirmation(
  challenge: StaffSetupChallenge | null,
  draft: StaffSetupDraft,
) {
  const checked = parseStaffSetupChallenge(challenge);
  if (
    !checked ||
    !/^\d{6}$/.test(draft.code) ||
    !isValidStaffLoginAlias(draft.loginAlias) ||
    draft.password.length < 12 ||
    draft.password.length > 128 ||
    draft.password !== draft.confirmation
  )
    return null;
  return {
    challengeId: checked.challengeId,
    challengeSecret: checked.challengeSecret,
    code: draft.code,
    loginAlias: normalizeStaffLoginAlias(draft.loginAlias),
    password: draft.password,
  };
}

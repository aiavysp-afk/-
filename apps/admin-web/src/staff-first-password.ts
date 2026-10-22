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
  /** Compatibility only; the current first-use form uses the bound phone. */
  loginAlias?: string;
  password: string;
  confirmation: string;
};

/** Static guidance only: never include the supplied credentials in feedback. */
export function getStaffSetupDraftIssues(
  draft: StaffSetupDraft,
): Record<keyof StaffSetupDraft, string | null> {
  return {
    code: /^\d{6}$/.test(draft.code)
      ? null
      : "请填写手机实际收到的6位短信验证码。",
    loginAlias:
      draft.loginAlias === undefined || isValidStaffLoginAlias(draft.loginAlias)
        ? null
        : "首次用户名须4–32位、英文字母开头，仅含英文字母、数字、下划线或短横线；不能直接填写手机号或中文。",
    password:
      draft.password.length >= 12 && draft.password.length <= 128
        ? null
        : "新密码须12–128个字符，请检查长度。",
    confirmation: !draft.confirmation
      ? "请再次输入新密码，且两次填写一致。"
      : draft.password !== draft.confirmation
        ? "两次新密码不一致，请重新核对。"
        : null,
  };
}

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
  if (!checked || Object.values(getStaffSetupDraftIssues(draft)).some(Boolean))
    return null;
  return {
    challengeId: checked.challengeId,
    challengeSecret: checked.challengeSecret,
    code: draft.code,
    ...(draft.loginAlias === undefined
      ? {}
      : { loginAlias: normalizeStaffLoginAlias(draft.loginAlias) }),
    password: draft.password,
  };
}

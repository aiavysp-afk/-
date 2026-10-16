import { hasFreshTotp } from "./login-state";

export const normalizeStaffLoginAlias = (value: string) =>
  value.trim().toLowerCase();

export const isValidStaffLoginAlias = (value: string) =>
  /^[a-z][a-z0-9_-]{3,31}$/.test(normalizeStaffLoginAlias(value));

export const normalizeStaffLoginAccount = normalizeStaffLoginAlias;

export const isValidStaffLoginAccount = (value: string) => {
  const account = normalizeStaffLoginAccount(value);
  return /^1[3-9]\d{9}$/.test(account) || isValidStaffLoginAlias(account);
};

export type StaffPasswordDraft = {
  loginAlias: string;
  password: string;
  confirmation: string;
};

export function buildStaffPasswordUpdate(
  draft: StaffPasswordDraft,
  authorization: {
    enabled: boolean;
    maskedAccount: string | null;
    verifiedUntil: string | null;
    busy: boolean;
  },
  now = Date.now(),
): { loginAlias: string; password: string } | null {
  if (
    authorization.busy ||
    !authorization.enabled ||
    !authorization.maskedAccount ||
    !hasFreshTotp({ verifiedUntil: authorization.verifiedUntil }, now) ||
    !isValidStaffLoginAlias(draft.loginAlias) ||
    draft.password.length < 12 ||
    draft.password.length > 128 ||
    draft.password !== draft.confirmation
  )
    return null;
  // The draft belongs only to the current component; never persist credentials.
  return {
    loginAlias: normalizeStaffLoginAlias(draft.loginAlias),
    password: draft.password,
  };
}

/** Ignore a late challenge when its account/method is no longer selected. */
export async function currentStaffPasswordChallenge<T>(
  submit: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  const result = await submit();
  return isCurrent() ? result : null;
}

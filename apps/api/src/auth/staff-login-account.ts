const ALIAS = /^[a-z][a-z0-9_-]{3,31}$/;
const PHONE = /^1[3-9]\d{9}$/;

/** User-chosen aliases are ASCII, case insensitive, and never a phone destination. */
export function normalizeStaffLoginAlias(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return ALIAS.test(normalized) ? normalized : null;
}

export function normalizeStaffLoginAccount(
  value: string,
): { kind: "phone" | "alias"; value: string } | null {
  const normalized = value.trim().toLowerCase();
  if (PHONE.test(normalized)) return { kind: "phone", value: normalized };
  return ALIAS.test(normalized) ? { kind: "alias", value: normalized } : null;
}

import type { AuthSession, AuthUser } from "@zydj/contracts";

/** Invalidates requests whenever the chosen method, challenge or component changes. */
export function createLoginGeneration() {
  let generation = 0;
  return {
    begin() {
      const attempt = ++generation;
      return () => attempt === generation;
    },
    invalidate() {
      generation++;
    },
  };
}

/** A trust cookie is only a server decision; a local checkbox is never MFA proof. */
export async function deliverBrowserSession(
  session: AuthSession,
  isCurrent: () => boolean,
  acceptTrustedDevice: (session: AuthSession) => Promise<unknown>,
  revoke: (session: AuthSession) => Promise<void>,
  onSession: (session: AuthSession) => void,
) {
  if (!isCurrent()) {
    await revoke(session);
    return false;
  }
  // An unavailable/off trust endpoint leaves the session requiring ordinary MFA.
  await acceptTrustedDevice(session).catch(() => undefined);
  if (!isCurrent()) {
    await revoke(session);
    return false;
  }
  onSession(session);
  return true;
}

export function hasFreshTotp(
  status: { verifiedUntil: string | null } | null,
  now = Date.now(),
) {
  return Boolean(
    status?.verifiedUntil && Date.parse(status.verifiedUntil) > now,
  );
}

export function managementOrganizationId(user: AuthUser) {
  const staffRoles = new Set([
    "ADMIN",
    "OPERATOR",
    "DISPATCHER",
    "FINANCE_REQUESTER",
    "FINANCE_APPROVER",
    "SAFETY_DUTY",
  ]);
  return (
    user.memberships.find((membership) => staffRoles.has(membership.role))
      ?.organizationId ?? ""
  );
}

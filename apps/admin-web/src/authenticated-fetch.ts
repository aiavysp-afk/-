/** Private in-memory identity/epoch routing; never exposes credentials in DOM events. */
export function createAdminSessionMonitor(
  confirmSession: (token: string) => Promise<number>,
) {
  type Scope = {
    token: string;
    onUnauthorized: () => void;
    isCurrent: () => boolean;
    confirmation?: Promise<void>;
  };
  let active: Scope | undefined;
  function invalidate(requested: Scope) {
    if (requested !== active || !requested.isCurrent()) return;
    active = undefined;
    requested.onUnauthorized();
  }
  return {
    register(
      token: string,
      onUnauthorized: () => void,
      isCurrent: () => boolean = () => true,
    ) {
      const scope = token ? { token, onUnauthorized, isCurrent } : undefined;
      active = scope;
      return () => {
        if (active === scope) active = undefined;
      };
    },
    capture(token: string | undefined) {
      const requested = token && active?.token === token ? active : undefined;
      return async (status: number, isSessionCheck = false) => {
        if (
          status !== 401 ||
          !requested ||
          requested !== active ||
          !requested.isCurrent()
        )
          return;
        if (isSessionCheck) {
          invalidate(requested);
          return;
        }
        // A business endpoint can return 401 for an incorrect TOTP, not just an expired session.
        // Deduplicate only the read-only identity check, never retry the original operation.
        if (!requested.confirmation) {
          requested.confirmation = Promise.resolve()
            .then(() => confirmSession(requested.token))
            .then((confirmedStatus) => {
              if (confirmedStatus === 401) invalidate(requested);
            })
            .catch(() => {})
            .finally(() => {
              requested.confirmation = undefined;
            });
        }
        await requested.confirmation;
      };
    },
  };
}

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1";
const SESSION_CHECK_URL = `${API_BASE_URL}/auth/me`;
const monitor = createAdminSessionMonitor(async (token) => {
  const response = await fetch(SESSION_CHECK_URL, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
});
export const registerAdminSession = monitor.register;

export async function authenticatedFetch(
  token: string | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const report = monitor.capture(token);
  const response = await fetch(input, init);
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  await report(response.status, url === SESSION_CHECK_URL);
  return response;
}

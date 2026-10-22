import type { H5OnboardingStatus } from "./h5-onboarding";

export const PHONE_TOKEN_STORAGE_KEY = "zydj.technician.phone-session-token";
export function technicianEntryRoute(
  hash: string,
  search: string,
  oauthEnabled: boolean,
) {
  if (
    hash.startsWith("#/wechat-callback") ||
    hash === "#/configuration-unavailable"
  )
    return oauthEnabled ? "wechat-onboarding" : "miniapp";
  return new URLSearchParams(search).get("login") === "wechat"
    ? "wechat-workbench"
    : "phone";
}
export type TechnicianPhoneCapabilities = {
  enabled: boolean;
  workbenchEnabled: boolean;
};
export type TechnicianPhoneChallenge = {
  challengeId: string;
  challengeSecret: string;
  maskedPhone: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export function phoneOnboardingPaths() {
  const base = "/technician/phone-onboarding";
  return {
    capabilities: "/auth/technician-phone/capabilities",
    smsRequest: "/auth/technician-phone/sms/request",
    smsConfirm: "/auth/technician-phone/sms/confirm",
    status: `${base}/status`,
    register: `${base}/register`,
    profile: `${base}/profile`,
    photos: `${base}/photos`,
    documents: `${base}/documents`,
    submit: `${base}/submit`,
    catalog: "/catalog/services",
  } as const;
}

export function isTechnicianPhone(value: string) {
  return /^1[3-9]\d{9}$/.test(value);
}
export function validPhoneChallenge(
  value: unknown,
  now = Date.now(),
): value is TechnicianPhoneChallenge {
  const input = value as Partial<TechnicianPhoneChallenge> | null;
  return Boolean(
    input &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.challengeId ?? "",
      ) &&
      /^[A-Za-z0-9_-]{43}$/.test(input.challengeSecret ?? "") &&
      typeof input.maskedPhone === "string" &&
      Number.isFinite(input.retryAfterSeconds) &&
      input.retryAfterSeconds! >= 0 &&
      input.retryAfterSeconds! <= 3600 &&
      Date.parse(input.expiresAt ?? "") > now,
  );
}
export function phoneWorkbenchAllowed(
  cap: TechnicianPhoneCapabilities | null,
  status: H5OnboardingStatus | null,
) {
  return (
    cap?.enabled === true &&
    cap.workbenchEnabled === true &&
    status?.stage === "APPROVED"
  );
}

// Only the token belongs in sessionStorage. SMS codes and challenge secrets stay in memory.
export function readPhoneToken() {
  try {
    return typeof window === "undefined"
      ? ""
      : (window.sessionStorage.getItem(PHONE_TOKEN_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}
export function storePhoneToken(token: string) {
  try {
    if (token) window.sessionStorage.setItem(PHONE_TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(PHONE_TOKEN_STORAGE_KEY);
  } catch {
    /* An unavailable browser store must not block an in-memory session. */
  }
}

export async function technicianRequest<T>(
  path: string,
  options: RequestInit = {},
  token = "",
): Promise<T> {
  const abort = new AbortController();
  let rejectTimeout!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectTimeout = () => reject(new Error("request timeout"));
  });
  const timeout = setTimeout(() => {
    abort.abort();
    rejectTimeout();
  }, 15_000);
  let responseStatus: number | undefined;
  try {
    const response = await Promise.race([
      fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3100/v1"}${path}`,
        {
          ...options,
          signal: abort.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...options.headers,
          },
        },
      ),
      expired,
    ]);
    responseStatus = response.status;
    const parsed = await Promise.race([
      response.json().catch(() => ({})),
      expired,
    ]);
    const body = (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {}
    ) as {
      data?: T;
      message?: unknown;
    };
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof body.message === "string"
            ? body.message
            : `请求失败（${response.status}）`,
        ),
        { status: response.status },
      );
    if (!("data" in body)) throw new Error("服务器返回不完整，请手动重试");
    return body.data as T;
  } catch (error) {
    if (
      (error as { status?: number } | null)?.status === responseStatus &&
      responseStatus !== undefined
    )
      throw error;
    if (responseStatus === 401 || responseStatus === 403)
      throw Object.assign(
        new Error(
          responseStatus === 401
            ? "登录会话已过期，请重新验证手机号"
            : "当前操作无权限，请返回入驻页重新验证",
        ),
        { status: responseStatus },
      );
    if (abort.signal.aborted)
      throw new Error(
        "请求超时，结果尚未确认；请检查网络后手动重试，不会自动重发短信",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

import {
  clearStoredSession,
  getStoredSession,
  redirectToCustomerLogin,
} from "./auth";

// HTTP rejections and uncertain transport failures must remain distinguishable.
// Do not include request bodies, headers or credentials in this error.
export class ApiError extends Error {
  readonly name = "ApiError";

  constructor(
    message: string,
    readonly statusCode: number,
    readonly path: string,
    readonly method: "GET" | "POST" | "PATCH" | "DELETE",
  ) {
    super(message);
  }
}

export function api<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  key?: string,
  authReturnPath?: string,
): Promise<T> {
  const app = getApp<{ globalData: { apiBaseUrl: string } }>();
  const session = getStoredSession();
  const hasData = data !== undefined;
  // Never retain the secret share token in generic error objects.
  const diagnosticPath = path.replace(/(\/friend-payments\/)[^/?]+/g, "$1[redacted]");
  return new Promise((resolve, reject) =>
    wx.request<{ data?: T; message?: string }>({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method,
      ...(hasData ? { data } : {}),
      header: {
        // wx.request defaults to JSON; an empty JSON body is rejected by the API.
        "content-type": hasData ? "application/json" : "text/plain",
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      success: (result) => {
        if (result.statusCode === 401) {
          clearStoredSession();
          redirectToCustomerLogin(authReturnPath);
        }
        if (
          result.statusCode >= 200 &&
          result.statusCode < 300 &&
          result.data.data !== undefined
        )
          resolve(result.data.data);
        else
          reject(
            new ApiError(
              result.data.message || `请求失败（${result.statusCode}）`,
              result.statusCode,
              diagnosticPath,
              method,
            ),
          );
      },
      fail: () => reject(new Error("网络连接失败，请保留当前页面后重试")),
    }),
  );
}
export const newKey = () =>
  `miniapp-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export const money = (fen: number) => (fen / 100).toFixed(2);
export const shanghaiTime = (iso: string) => {
  const date = new Date(Date.parse(iso) + 8 * 3600_000);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
};

import {
  clearStoredSession,
  getStoredSession,
  redirectToCustomerLogin,
} from "./auth";
export function api<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  data?: unknown,
  key?: string,
): Promise<T> {
  const app = getApp<{ globalData: { apiBaseUrl: string } }>();
  const session = getStoredSession();
  return new Promise((resolve, reject) =>
    wx.request<{ data?: T; message?: string }>({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method,
      data,
      header: {
        "content-type": "application/json",
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      success: (result) => {
        if (result.statusCode === 401) {
          clearStoredSession();
          redirectToCustomerLogin();
        }
        if (
          result.statusCode >= 200 &&
          result.statusCode < 300 &&
          result.data.data !== undefined
        )
          resolve(result.data.data);
        else
          reject(
            new Error(
              result.data.message || `请求失败（${result.statusCode}）`,
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

import type { AuthSession } from "@zydj/contracts";

const STORAGE_KEY = "zydj.auth.session";

interface AppContext {
  globalData: {
    apiBaseUrl: string;
  };
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
}

export const getStoredSession = () => {
  const value = wx.getStorageSync(STORAGE_KEY);
  if (!value || typeof value !== "object") return undefined;
  const session = value as Partial<AuthSession>;
  if (!session.accessToken || !session.expiresAt || !session.user)
    return undefined;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    wx.removeStorageSync(STORAGE_KEY);
    return undefined;
  }
  return session as AuthSession;
};

export const clearStoredSession = () => wx.removeStorageSync(STORAGE_KEY);

export const loginWithWechat = async () => {
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (result) =>
        result.code
          ? resolve(result.code)
          : reject(new Error("微信未返回登录凭证")),
      fail: (error) => reject(new Error(error.errMsg || "微信登录失败")),
    });
  });
  const app = getApp<AppContext>();
  const session = await new Promise<AuthSession>((resolve, reject) => {
    wx.request<ApiResponse<AuthSession>>({
      url: `${app.globalData.apiBaseUrl}/auth/wechat-miniapp`,
      method: "POST",
      data: { code },
      header: { "content-type": "application/json" },
      success: (result) => {
        if (result.statusCode === 200 && result.data.data)
          resolve(result.data.data);
        else reject(new Error(result.data.message || "登录服务暂时不可用"));
      },
      fail: (error) => reject(new Error(error.errMsg || "无法连接登录服务")),
    });
  });
  wx.setStorageSync(STORAGE_KEY, session);
  return session;
};

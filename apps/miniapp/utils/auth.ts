import type {
  AuthSession,
  SmsPhoneVerificationRequestResult,
  WechatPhoneVerificationResult,
} from "@zydj/contracts";

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

export const needsPhoneVerification = (session = getStoredSession()) =>
  Boolean(session && session.user.phoneVerified !== true);

export const goToPhoneVerification = () =>
  wx.navigateTo({ url: "/pages/phone-verification/index" });

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

export const verifyWechatPhone = async (code: string) => {
  const session = getStoredSession();
  if (!session) throw new Error("请先完成微信授权登录");
  const app = getApp<AppContext>();
  const result = await new Promise<WechatPhoneVerificationResult>(
    (resolve, reject) => {
      wx.request<ApiResponse<WechatPhoneVerificationResult>>({
        url: `${app.globalData.apiBaseUrl}/auth/wechat-phone`,
        method: "POST",
        data: { code },
        header: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
        success: (response) => {
          if (response.statusCode === 200 && response.data.data) {
            resolve(response.data.data);
          } else {
            reject(new Error(response.data.message || "手机号验证暂时不可用"));
          }
        },
        fail: (error) =>
          reject(new Error(error.errMsg || "无法连接手机号验证服务")),
      });
    },
  );
  const nextSession: AuthSession = {
    ...session,
    user: { ...session.user, phoneVerified: true },
  };
  wx.setStorageSync(STORAGE_KEY, nextSession);
  return result;
};

export const requestSmsPhoneVerification = async (phone: string) => {
  const session = getStoredSession();
  if (!session) throw new Error("请先完成微信授权登录");
  const app = getApp<AppContext>();
  return new Promise<SmsPhoneVerificationRequestResult>((resolve, reject) => {
    wx.request<ApiResponse<SmsPhoneVerificationRequestResult>>({
      url: `${app.globalData.apiBaseUrl}/auth/sms-phone/request`,
      method: "POST",
      data: { phone },
      header: {
        "content-type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      success: (response) => {
        if (response.statusCode === 200 && response.data.data)
          resolve(response.data.data);
        else reject(new Error(response.data.message || "验证码发送暂时不可用"));
      },
      fail: (error) => reject(new Error(error.errMsg || "无法连接短信服务")),
    });
  });
};

export const confirmSmsPhoneVerification = async (
  phone: string,
  code: string,
) => {
  const session = getStoredSession();
  if (!session) throw new Error("请先完成微信授权登录");
  const app = getApp<AppContext>();
  const result = await new Promise<WechatPhoneVerificationResult>(
    (resolve, reject) => {
      wx.request<ApiResponse<WechatPhoneVerificationResult>>({
        url: `${app.globalData.apiBaseUrl}/auth/sms-phone/confirm`,
        method: "POST",
        data: { phone, code },
        header: {
          "content-type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
        success: (response) => {
          if (response.statusCode === 200 && response.data.data)
            resolve(response.data.data);
          else reject(new Error(response.data.message || "短信验证失败"));
        },
        fail: (error) => reject(new Error(error.errMsg || "无法连接验证服务")),
      });
    },
  );
  wx.setStorageSync(STORAGE_KEY, {
    ...session,
    user: { ...session.user, phoneVerified: true },
  } satisfies AuthSession);
  return result;
};

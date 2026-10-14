import type {
  AuthSession,
  CustomerLoginCapabilities,
  CustomerSmsLoginRequestResult,
  SmsPhoneVerificationRequestResult,
  WechatPhoneVerificationResult,
} from "@zydj/contracts";
import { safeLoginReturnPath } from "./login-return";

const STORAGE_KEY = "zydj.auth.session";
const CUSTOMER_LOGIN_URL = "/pages/phone-verification/index?required=1";
let customerLoginRedirecting = false;

interface AppContext {
  globalData: {
    apiBaseUrl: string;
  };
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
}

const networkFailureMessage = (error: { errMsg?: string }, fallback: string) =>
  /timeout/i.test(error.errMsg ?? "") ? "请求超时，请检查网络后重试" : fallback;

export const getStoredSession = () => {
  const value = wx.getStorageSync(STORAGE_KEY);
  if (!value || typeof value !== "object") return undefined;
  const session = value as Partial<AuthSession>;
  if (!session.accessToken || !session.expiresAt || !session.user)
    return undefined;
  if (
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= Date.now()
  ) {
    wx.removeStorageSync(STORAGE_KEY);
    return undefined;
  }
  return session as AuthSession;
};

export const clearStoredSession = () => wx.removeStorageSync(STORAGE_KEY);

export const needsPhoneVerification = (session = getStoredSession()) =>
  Boolean(session && session.user.phoneVerified !== true);

export const hasVerifiedCustomerSession = () =>
  getStoredSession()?.user.phoneVerified === true;

export const redirectToCustomerLogin = (returnPath?: string) => {
  if (customerLoginRedirecting) return;
  customerLoginRedirecting = true;
  wx.reLaunch({
    url:
      CUSTOMER_LOGIN_URL +
      (safeLoginReturnPath(returnPath)
        ? `&returnPath=${encodeURIComponent(safeLoginReturnPath(returnPath))}`
        : ""),
    complete: () => {
      customerLoginRedirecting = false;
    },
  });
};

export const requireVerifiedCustomerAccess = (returnPath?: string) => {
  if (hasVerifiedCustomerSession()) return true;
  redirectToCustomerLogin(returnPath);
  return false;
};

export const goToPhoneVerification = () =>
  wx.navigateTo({ url: "/pages/phone-verification/index?forceChoice=1" });

const assertCustomerConsent = (accepted: boolean) => {
  if (accepted !== true)
    throw new Error("请先阅读并同意用户协议、隐私政策与上门服务公约");
};

// Customer SMS login must not depend on a previous WeChat/staff session. Never
// forward the old bearer token or include credentials in error diagnostics.
const customerLoginRequest = <T>(path: string, data?: unknown) => {
  const app = getApp<AppContext>();
  return new Promise<T>((resolve, reject) => {
    wx.request<ApiResponse<T>>({
      url: `${app.globalData.apiBaseUrl}/auth/customer-login${path}`,
      method: data === undefined ? "GET" : "POST",
      timeout: 20_000,
      ...(data === undefined ? {} : { data }),
      header: {
        "content-type": data === undefined ? "text/plain" : "application/json",
      },
      success: (response) => {
        if (response.statusCode === 200 && response.data.data !== undefined)
          resolve(response.data.data);
        else reject(new Error(response.data.message || "登录服务暂时不可用"));
      },
      fail: (error) =>
        reject(new Error(networkFailureMessage(error, "无法连接登录服务"))),
    });
  });
};

const saveVerifiedCustomerSession = (session: AuthSession) => {
  if (
    !session?.accessToken ||
    !session?.user?.id ||
    session.user.phoneVerified !== true ||
    !Array.isArray(session.user.memberships) ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    throw new Error("登录验证未完成，请重试");
  wx.setStorageSync(STORAGE_KEY, session);
  return session;
};

export const getCustomerLoginCapabilities = () =>
  customerLoginRequest<CustomerLoginCapabilities>("/capabilities");

// getPhoneNumber and wx.login supply different, single-use codes. One native
// user-authorized click supplies both to one atomic server login, without
// creating a temporary user/session or a second visible verification step.
export const loginCustomerWithWechatPhone = async (
  phoneCode: string,
  agreementsAccepted = false,
) => {
  assertCustomerConsent(agreementsAccepted);
  if (!phoneCode?.trim()) throw new Error("请先同意微信手机号授权");
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (result) =>
        result.code
          ? resolve(result.code)
          : reject(new Error("微信未返回登录凭证")),
      fail: () => reject(new Error("微信登录未完成，请重试")),
    });
  });
  const session = await customerLoginRequest<AuthSession>("/wechat-phone", {
    code,
    phoneCode,
    agreementsAccepted,
  });
  return saveVerifiedCustomerSession({ ...session, loginMethod: "WECHAT" });
};

export const requestCustomerSmsLogin = async (
  phone: string,
  agreementsAccepted = false,
) => {
  assertCustomerConsent(agreementsAccepted);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("请输入正确的 11 位手机号");
  return customerLoginRequest<CustomerSmsLoginRequestResult>("/sms/request", {
    phone,
    agreementsAccepted,
  });
};

export const confirmCustomerSmsLogin = async (
  phone: string,
  code: string,
  challengeId: string,
  agreementsAccepted = false,
) => {
  assertCustomerConsent(agreementsAccepted);
  if (
    !/^1[3-9]\d{9}$/.test(phone) ||
    !/^\d{6}$/.test(code) ||
    !challengeId ||
    challengeId.length < 16 ||
    challengeId.length > 128
  )
    throw new Error("请先获取并填写正确的短信验证码");
  const session = await customerLoginRequest<AuthSession>("/sms/confirm", {
    phone,
    code,
    challengeId,
    agreementsAccepted,
  });
  return saveVerifiedCustomerSession({ ...session, loginMethod: "PHONE_SMS" });
};

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
      timeout: 12_000,
      data: { code },
      header: { "content-type": "application/json" },
      success: (result) => {
        if (result.statusCode === 200 && result.data.data)
          resolve(result.data.data);
        else reject(new Error(result.data.message || "登录服务暂时不可用"));
      },
      fail: (error) =>
        reject(new Error(networkFailureMessage(error, "无法连接登录服务"))),
    });
  });
  const nextSession: AuthSession = { ...session, loginMethod: "WECHAT" };
  wx.setStorageSync(STORAGE_KEY, nextSession);
  return nextSession;
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
        timeout: 12_000,
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
          reject(
            new Error(networkFailureMessage(error, "无法连接手机号验证服务")),
          ),
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
      timeout: 12_000,
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
      fail: (error) =>
        reject(new Error(networkFailureMessage(error, "无法连接短信服务"))),
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
        timeout: 12_000,
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
        fail: (error) =>
          reject(new Error(networkFailureMessage(error, "无法连接验证服务"))),
      });
    },
  );
  wx.setStorageSync(STORAGE_KEY, {
    ...session,
    user: { ...session.user, phoneVerified: true },
  } satisfies AuthSession);
  return result;
};

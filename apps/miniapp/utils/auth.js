"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmSmsPhoneVerification = exports.requestSmsPhoneVerification = exports.verifyWechatPhone = exports.loginWithWechat = exports.confirmCustomerSmsLogin = exports.requestCustomerSmsLogin = exports.loginCustomerWithWechatPhone = exports.getCustomerLoginCapabilities = exports.goToPhoneVerification = exports.requireVerifiedCustomerAccess = exports.redirectToCustomerLogin = exports.hasVerifiedCustomerSession = exports.needsPhoneVerification = exports.clearStoredSession = exports.getStoredSession = void 0;
const login_return_1 = require("./login-return");
const STORAGE_KEY = "zydj.auth.session";
const CUSTOMER_LOGIN_URL = "/pages/phone-verification/index?required=1";
let customerLoginRedirecting = false;
const networkFailureMessage = (error, fallback) => { var _a; return /timeout/i.test((_a = error.errMsg) !== null && _a !== void 0 ? _a : "") ? "请求超时，请检查网络后重试" : fallback; };
const getStoredSession = () => {
    const value = wx.getStorageSync(STORAGE_KEY);
    if (!value || typeof value !== "object")
        return undefined;
    const session = value;
    if (!session.accessToken || !session.expiresAt || !session.user)
        return undefined;
    if (!Number.isFinite(Date.parse(session.expiresAt)) ||
        Date.parse(session.expiresAt) <= Date.now()) {
        wx.removeStorageSync(STORAGE_KEY);
        return undefined;
    }
    return session;
};
exports.getStoredSession = getStoredSession;
const clearStoredSession = () => wx.removeStorageSync(STORAGE_KEY);
exports.clearStoredSession = clearStoredSession;
const needsPhoneVerification = (session = (0, exports.getStoredSession)()) => Boolean(session && session.user.phoneVerified !== true);
exports.needsPhoneVerification = needsPhoneVerification;
const hasVerifiedCustomerSession = () => { var _a; return ((_a = (0, exports.getStoredSession)()) === null || _a === void 0 ? void 0 : _a.user.phoneVerified) === true; };
exports.hasVerifiedCustomerSession = hasVerifiedCustomerSession;
const redirectToCustomerLogin = (returnPath) => {
    if (customerLoginRedirecting)
        return;
    customerLoginRedirecting = true;
    wx.reLaunch({
        url: CUSTOMER_LOGIN_URL +
            ((0, login_return_1.safeLoginReturnPath)(returnPath)
                ? `&returnPath=${encodeURIComponent((0, login_return_1.safeLoginReturnPath)(returnPath))}`
                : ""),
        complete: () => {
            customerLoginRedirecting = false;
        },
    });
};
exports.redirectToCustomerLogin = redirectToCustomerLogin;
const requireVerifiedCustomerAccess = (returnPath) => {
    if ((0, exports.hasVerifiedCustomerSession)())
        return true;
    (0, exports.redirectToCustomerLogin)(returnPath);
    return false;
};
exports.requireVerifiedCustomerAccess = requireVerifiedCustomerAccess;
const goToPhoneVerification = () => wx.navigateTo({ url: "/pages/phone-verification/index?forceChoice=1" });
exports.goToPhoneVerification = goToPhoneVerification;
const assertCustomerConsent = (accepted) => {
    if (accepted !== true)
        throw new Error("请先阅读并同意用户协议、隐私政策与上门服务公约");
};
// Customer SMS login must not depend on a previous WeChat/staff session. Never
// forward the old bearer token or include credentials in error diagnostics.
const customerLoginRequest = (path, data) => {
    const app = getApp();
    return new Promise((resolve, reject) => {
        wx.request({
            url: `${app.globalData.apiBaseUrl}/auth/customer-login${path}`,
            method: data === undefined ? "GET" : "POST",
            timeout: 20000,
            ...(data === undefined ? {} : { data }),
            header: {
                "content-type": data === undefined ? "text/plain" : "application/json",
            },
            success: (response) => {
                if (response.statusCode === 200 && response.data.data !== undefined)
                    resolve(response.data.data);
                else
                    reject(new Error(response.data.message || "登录服务暂时不可用"));
            },
            fail: (error) => reject(new Error(networkFailureMessage(error, "无法连接登录服务"))),
        });
    });
};
const saveVerifiedCustomerSession = (session) => {
    var _a;
    if (!(session === null || session === void 0 ? void 0 : session.accessToken) ||
        !((_a = session === null || session === void 0 ? void 0 : session.user) === null || _a === void 0 ? void 0 : _a.id) ||
        session.user.phoneVerified !== true ||
        !Array.isArray(session.user.memberships) ||
        !Number.isFinite(Date.parse(session.expiresAt)) ||
        Date.parse(session.expiresAt) <= Date.now())
        throw new Error("登录验证未完成，请重试");
    wx.setStorageSync(STORAGE_KEY, session);
    return session;
};
const getCustomerLoginCapabilities = () => customerLoginRequest("/capabilities");
exports.getCustomerLoginCapabilities = getCustomerLoginCapabilities;
// getPhoneNumber and wx.login supply different, single-use codes. One native
// user-authorized click supplies both to one atomic server login, without
// creating a temporary user/session or a second visible verification step.
const loginCustomerWithWechatPhone = async (phoneCode, agreementsAccepted = false) => {
    assertCustomerConsent(agreementsAccepted);
    if (!(phoneCode === null || phoneCode === void 0 ? void 0 : phoneCode.trim()))
        throw new Error("请先同意微信手机号授权");
    const code = await new Promise((resolve, reject) => {
        wx.login({
            success: (result) => result.code
                ? resolve(result.code)
                : reject(new Error("微信未返回登录凭证")),
            fail: () => reject(new Error("微信登录未完成，请重试")),
        });
    });
    const session = await customerLoginRequest("/wechat-phone", {
        code,
        phoneCode,
        agreementsAccepted,
    });
    return saveVerifiedCustomerSession({ ...session, loginMethod: "WECHAT" });
};
exports.loginCustomerWithWechatPhone = loginCustomerWithWechatPhone;
const requestCustomerSmsLogin = async (phone, agreementsAccepted = false) => {
    assertCustomerConsent(agreementsAccepted);
    if (!/^1[3-9]\d{9}$/.test(phone))
        throw new Error("请输入正确的 11 位手机号");
    return customerLoginRequest("/sms/request", {
        phone,
        agreementsAccepted,
    });
};
exports.requestCustomerSmsLogin = requestCustomerSmsLogin;
const confirmCustomerSmsLogin = async (phone, code, challengeId, agreementsAccepted = false) => {
    assertCustomerConsent(agreementsAccepted);
    if (!/^1[3-9]\d{9}$/.test(phone) ||
        !/^\d{6}$/.test(code) ||
        !challengeId ||
        challengeId.length < 16 ||
        challengeId.length > 128)
        throw new Error("请先获取并填写正确的短信验证码");
    const session = await customerLoginRequest("/sms/confirm", {
        phone,
        code,
        challengeId,
        agreementsAccepted,
    });
    return saveVerifiedCustomerSession({ ...session, loginMethod: "PHONE_SMS" });
};
exports.confirmCustomerSmsLogin = confirmCustomerSmsLogin;
const loginWithWechat = async () => {
    const code = await new Promise((resolve, reject) => {
        wx.login({
            success: (result) => result.code
                ? resolve(result.code)
                : reject(new Error("微信未返回登录凭证")),
            fail: (error) => reject(new Error(error.errMsg || "微信登录失败")),
        });
    });
    const app = getApp();
    const session = await new Promise((resolve, reject) => {
        wx.request({
            url: `${app.globalData.apiBaseUrl}/auth/wechat-miniapp`,
            method: "POST",
            timeout: 12000,
            data: { code },
            header: { "content-type": "application/json" },
            success: (result) => {
                if (result.statusCode === 200 && result.data.data)
                    resolve(result.data.data);
                else
                    reject(new Error(result.data.message || "登录服务暂时不可用"));
            },
            fail: (error) => reject(new Error(networkFailureMessage(error, "无法连接登录服务"))),
        });
    });
    const nextSession = { ...session, loginMethod: "WECHAT" };
    wx.setStorageSync(STORAGE_KEY, nextSession);
    return nextSession;
};
exports.loginWithWechat = loginWithWechat;
const verifyWechatPhone = async (code) => {
    const session = (0, exports.getStoredSession)();
    if (!session)
        throw new Error("请先完成微信授权登录");
    const app = getApp();
    const result = await new Promise((resolve, reject) => {
        wx.request({
            url: `${app.globalData.apiBaseUrl}/auth/wechat-phone`,
            method: "POST",
            timeout: 12000,
            data: { code },
            header: {
                "content-type": "application/json",
                Authorization: `Bearer ${session.accessToken}`,
            },
            success: (response) => {
                if (response.statusCode === 200 && response.data.data) {
                    resolve(response.data.data);
                }
                else {
                    reject(new Error(response.data.message || "手机号验证暂时不可用"));
                }
            },
            fail: (error) => reject(new Error(networkFailureMessage(error, "无法连接手机号验证服务"))),
        });
    });
    const nextSession = {
        ...session,
        user: { ...session.user, phoneVerified: true },
    };
    wx.setStorageSync(STORAGE_KEY, nextSession);
    return result;
};
exports.verifyWechatPhone = verifyWechatPhone;
const requestSmsPhoneVerification = async (phone) => {
    const session = (0, exports.getStoredSession)();
    if (!session)
        throw new Error("请先完成微信授权登录");
    const app = getApp();
    return new Promise((resolve, reject) => {
        wx.request({
            url: `${app.globalData.apiBaseUrl}/auth/sms-phone/request`,
            method: "POST",
            timeout: 12000,
            data: { phone },
            header: {
                "content-type": "application/json",
                Authorization: `Bearer ${session.accessToken}`,
            },
            success: (response) => {
                if (response.statusCode === 200 && response.data.data)
                    resolve(response.data.data);
                else
                    reject(new Error(response.data.message || "验证码发送暂时不可用"));
            },
            fail: (error) => reject(new Error(networkFailureMessage(error, "无法连接短信服务"))),
        });
    });
};
exports.requestSmsPhoneVerification = requestSmsPhoneVerification;
const confirmSmsPhoneVerification = async (phone, code) => {
    const session = (0, exports.getStoredSession)();
    if (!session)
        throw new Error("请先完成微信授权登录");
    const app = getApp();
    const result = await new Promise((resolve, reject) => {
        wx.request({
            url: `${app.globalData.apiBaseUrl}/auth/sms-phone/confirm`,
            method: "POST",
            timeout: 12000,
            data: { phone, code },
            header: {
                "content-type": "application/json",
                Authorization: `Bearer ${session.accessToken}`,
            },
            success: (response) => {
                if (response.statusCode === 200 && response.data.data)
                    resolve(response.data.data);
                else
                    reject(new Error(response.data.message || "短信验证失败"));
            },
            fail: (error) => reject(new Error(networkFailureMessage(error, "无法连接验证服务"))),
        });
    });
    wx.setStorageSync(STORAGE_KEY, {
        ...session,
        user: { ...session.user, phoneVerified: true },
    });
    return result;
};
exports.confirmSmsPhoneVerification = confirmSmsPhoneVerification;

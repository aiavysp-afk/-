"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmSmsPhoneVerification = exports.requestSmsPhoneVerification = exports.verifyWechatPhone = exports.loginWithWechat = exports.goToPhoneVerification = exports.needsPhoneVerification = exports.clearStoredSession = exports.getStoredSession = void 0;
const STORAGE_KEY = "zydj.auth.session";
const getStoredSession = () => {
    const value = wx.getStorageSync(STORAGE_KEY);
    if (!value || typeof value !== "object")
        return undefined;
    const session = value;
    if (!session.accessToken || !session.expiresAt || !session.user)
        return undefined;
    if (Date.parse(session.expiresAt) <= Date.now()) {
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
const goToPhoneVerification = () => wx.navigateTo({ url: "/pages/phone-verification/index" });
exports.goToPhoneVerification = goToPhoneVerification;
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
            data: { code },
            header: { "content-type": "application/json" },
            success: (result) => {
                if (result.statusCode === 200 && result.data.data)
                    resolve(result.data.data);
                else
                    reject(new Error(result.data.message || "登录服务暂时不可用"));
            },
            fail: (error) => reject(new Error(error.errMsg || "无法连接登录服务")),
        });
    });
    wx.setStorageSync(STORAGE_KEY, session);
    return session;
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
            fail: (error) => reject(new Error(error.errMsg || "无法连接手机号验证服务")),
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
            fail: (error) => reject(new Error(error.errMsg || "无法连接短信服务")),
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
            fail: (error) => reject(new Error(error.errMsg || "无法连接验证服务")),
        });
    });
    wx.setStorageSync(STORAGE_KEY, {
        ...session,
        user: { ...session.user, phoneVerified: true },
    });
    return result;
};
exports.confirmSmsPhoneVerification = confirmSmsPhoneVerification;

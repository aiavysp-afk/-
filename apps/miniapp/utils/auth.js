"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginWithWechat = exports.clearStoredSession = exports.getStoredSession = void 0;
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

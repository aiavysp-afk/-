"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shanghaiTime = exports.money = exports.newKey = void 0;
exports.api = api;
const auth_1 = require("./auth");
function api(path, method = "GET", data, key) {
    const app = getApp();
    const session = (0, auth_1.getStoredSession)();
    return new Promise((resolve, reject) => wx.request({
        url: `${app.globalData.apiBaseUrl}${path}`,
        method,
        data,
        header: {
            "content-type": "application/json",
            ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
            ...(key ? { "Idempotency-Key": key } : {}),
        },
        success: (result) => {
            if (result.statusCode === 401)
                (0, auth_1.clearStoredSession)();
            if (result.statusCode >= 200 &&
                result.statusCode < 300 &&
                result.data.data !== undefined)
                resolve(result.data.data);
            else
                reject(new Error(result.data.message || `请求失败（${result.statusCode}）`));
        },
        fail: () => reject(new Error("网络连接失败，请保留当前页面后重试")),
    }));
}
const newKey = () => `miniapp-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
exports.newKey = newKey;
const money = (fen) => (fen / 100).toFixed(2);
exports.money = money;
const shanghaiTime = (iso) => {
    const date = new Date(Date.parse(iso) + 8 * 3600000);
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
};
exports.shanghaiTime = shanghaiTime;

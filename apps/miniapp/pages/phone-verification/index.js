"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
Page({
    data: {
        busy: false,
        completed: false,
        maskedPhone: "",
        error: "",
        phone: "",
        smsCode: "",
        smsRequested: false,
        smsCountdown: 0,
    },
    countdownTimer: undefined,
    onLoad() {
        const session = (0, auth_1.getStoredSession)();
        if (!session) {
            wx.showToast({ title: "请先微信授权登录", icon: "none" });
            wx.switchTab({ url: "/pages/profile/index" });
            return;
        }
        if (!(0, auth_1.needsPhoneVerification)(session)) {
            this.setData({ completed: true });
        }
    },
    onUnload() {
        if (this.countdownTimer)
            clearInterval(this.countdownTimer);
    },
    async verifyPhone(event) {
        var _a, _b;
        if (this.data.busy)
            return;
        const code = event.detail.code;
        if (!code) {
            this.setData({
                error: ((_a = event.detail.errMsg) === null || _a === void 0 ? void 0 : _a.includes("deny")) ||
                    ((_b = event.detail.errMsg) === null || _b === void 0 ? void 0 : _b.includes("cancel"))
                    ? "你已取消手机号授权，完成验证后才能提交订单"
                    : "微信未返回手机号授权凭证，请重试",
            });
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            const result = await (0, auth_1.verifyWechatPhone)(code);
            this.setData({
                completed: true,
                maskedPhone: result.maskedPhone,
            });
            wx.showToast({ title: "验证成功", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "手机号验证失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    updatePhone(event) {
        this.setData({ phone: event.detail.value.replace(/\D/g, "").slice(0, 11) });
    },
    updateSmsCode(event) {
        this.setData({
            smsCode: event.detail.value.replace(/\D/g, "").slice(0, 6),
        });
    },
    async requestSmsCode() {
        if (this.data.busy || this.data.smsCountdown > 0)
            return;
        if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
            this.setData({ error: "请输入正确的 11 位手机号" });
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            const result = await (0, auth_1.requestSmsPhoneVerification)(this.data.phone);
            this.setData({
                smsRequested: true,
                smsCountdown: result.retryAfterSeconds,
                error: result.status === "UNKNOWN"
                    ? "短信请求状态暂未确认，请稍候查看；不要连续点击"
                    : "",
            });
            if (this.countdownTimer)
                clearInterval(this.countdownTimer);
            this.countdownTimer = setInterval(() => {
                const next = Math.max(0, this.data.smsCountdown - 1);
                this.setData({ smsCountdown: next });
                if (next === 0 && this.countdownTimer) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = undefined;
                }
            }, 1000);
            wx.showToast({ title: "验证码已申请", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "验证码发送失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async confirmSmsCode() {
        if (this.data.busy)
            return;
        if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
            this.setData({ error: "请输入正确的 11 位手机号" });
            return;
        }
        if (!/^\d{4,6}$/.test(this.data.smsCode)) {
            this.setData({ error: "请输入短信中的 4–6 位验证码" });
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            const result = await (0, auth_1.confirmSmsPhoneVerification)(this.data.phone, this.data.smsCode);
            this.setData({ completed: true, maskedPhone: result.maskedPhone });
            wx.showToast({ title: "验证成功", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "短信验证失败",
            });
        }
        finally {
            this.setData({ busy: false });
        }
    },
    finish() {
        wx.navigateBack({ delta: 1 });
    },
});

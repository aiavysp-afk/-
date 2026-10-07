"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
Page({
    data: {
        accepted: true,
        busy: false,
        codeFocused: false,
        completed: false,
        error: "",
        loginMode: "",
        maskedPhone: "",
        phone: "",
        phoneFocused: false,
        smsCode: "",
        smsCountdown: 0,
        smsRequested: false,
    },
    countdownTimer: undefined,
    onLoad() {
        const session = (0, auth_1.getStoredSession)();
        if (session && !(0, auth_1.needsPhoneVerification)(session)) {
            this.setData({ completed: true });
        }
    },
    onUnload() {
        if (this.countdownTimer)
            clearInterval(this.countdownTimer);
    },
    async ensureWechatSession() {
        var _a;
        return (_a = (0, auth_1.getStoredSession)()) !== null && _a !== void 0 ? _a : (0, auth_1.loginWithWechat)();
    },
    ensureAgreementAccepted() {
        if (this.data.accepted)
            return true;
        this.setData({ error: "请先阅读并同意用户协议、隐私政策与上门服务公约" });
        return false;
    },
    async quickLogin(event) {
        var _a, _b;
        if (this.data.busy || !this.ensureAgreementAccepted())
            return;
        const code = event.detail.code;
        if (!code) {
            this.setData({
                error: ((_a = event.detail.errMsg) === null || _a === void 0 ? void 0 : _a.includes("deny")) ||
                    ((_b = event.detail.errMsg) === null || _b === void 0 ? void 0 : _b.includes("cancel"))
                    ? "你已取消手机号授权，也可以使用下方短信验证码登录"
                    : "微信未返回手机号授权凭证，请重试",
            });
            return;
        }
        this.setData({ busy: true, error: "", loginMode: "QUICK" });
        try {
            await this.ensureWechatSession();
            const result = await (0, auth_1.verifyWechatPhone)(code);
            this.setData({ completed: true, maskedPhone: result.maskedPhone });
            wx.showToast({ title: "登录成功", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "手机号登录失败",
            });
        }
        finally {
            this.setData({ busy: false, loginMode: "" });
        }
    },
    updatePhone(event) {
        this.setData({
            phone: event.detail.value.replace(/\D/g, "").slice(0, 11),
            error: "",
        });
    },
    updateSmsCode(event) {
        this.setData({
            smsCode: event.detail.value.replace(/\D/g, "").slice(0, 6),
            error: "",
        });
    },
    focusPhone() {
        this.setData({ phoneFocused: true });
    },
    blurPhone() {
        this.setData({ phoneFocused: false });
    },
    focusCode() {
        this.setData({ codeFocused: true });
    },
    blurCode() {
        this.setData({ codeFocused: false });
    },
    toggleAccepted() {
        this.setData({ accepted: !this.data.accepted, error: "" });
    },
    openAgreement(event) {
        var _a;
        const type = (_a = event.currentTarget.dataset.type) !== null && _a !== void 0 ? _a : "user";
        wx.navigateTo({ url: `/pages/agreement/index?type=${type}` });
    },
    async handleSmsAction() {
        if (this.data.smsRequested)
            await this.confirmSmsCode();
        else
            await this.requestSmsCode();
    },
    async requestSmsCode() {
        if (this.data.busy ||
            this.data.smsCountdown > 0 ||
            !this.ensureAgreementAccepted())
            return;
        if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
            this.setData({ error: "请输入正确的 11 位手机号" });
            return;
        }
        this.setData({ busy: true, error: "", loginMode: "SMS" });
        try {
            await this.ensureWechatSession();
            const result = await (0, auth_1.requestSmsPhoneVerification)(this.data.phone);
            this.setData({
                smsRequested: true,
                smsCountdown: result.retryAfterSeconds,
                error: result.status === "UNKNOWN"
                    ? "短信请求状态暂未确认，请稍候查看，暂勿重复点击"
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
            wx.showToast({ title: "验证码已发送", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "验证码发送失败",
            });
        }
        finally {
            this.setData({ busy: false, loginMode: "" });
        }
    },
    async confirmSmsCode() {
        if (this.data.busy || !this.ensureAgreementAccepted())
            return;
        if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
            this.setData({ error: "请输入正确的 11 位手机号" });
            return;
        }
        if (!/^\d{4,6}$/.test(this.data.smsCode)) {
            this.setData({ error: "请输入短信中的 4–6 位验证码" });
            return;
        }
        this.setData({ busy: true, error: "", loginMode: "SMS" });
        try {
            await this.ensureWechatSession();
            const result = await (0, auth_1.confirmSmsPhoneVerification)(this.data.phone, this.data.smsCode);
            this.setData({ completed: true, maskedPhone: result.maskedPhone });
            wx.showToast({ title: "登录成功", icon: "success" });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "验证码登录失败",
            });
        }
        finally {
            this.setData({ busy: false, loginMode: "" });
        }
    },
    enterHome() {
        wx.switchTab({ url: "/pages/home/index" });
    },
    finish() {
        wx.navigateBack({ delta: 1 });
    },
});

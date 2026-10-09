"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
const friend_payment_1 = require("../../utils/friend-payment");
Page({
    data: {
        accepted: true,
        actionStatus: "",
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
        wechatReady: false,
        requiredEntry: false,
        friendPaymentReturn: false,
    },
    returnPath: "",
    countdownTimer: undefined,
    onLoad(options) {
        this.returnPath = (0, friend_payment_1.safeFriendPaymentReturnPath)(options.returnPath);
        this.setData({ requiredEntry: options.required === "1", friendPaymentReturn: Boolean(this.returnPath) });
        const session = (0, auth_1.getStoredSession)();
        if (!this.returnPath && session && !(0, auth_1.needsPhoneVerification)(session)) {
            this.setData({ completed: true, wechatReady: true });
        }
        else if (!this.returnPath && session) {
            this.setData({ wechatReady: true });
        }
    },
    onUnload() {
        if (this.countdownTimer)
            clearInterval(this.countdownTimer);
    },
    ensureAgreementAccepted() {
        if (this.data.accepted)
            return true;
        this.setData({ error: "请先阅读并同意用户协议、隐私政策与上门服务公约" });
        return false;
    },
    async authorizeWechat() {
        var _a;
        if (this.data.busy || !this.ensureAgreementAccepted())
            return;
        this.setData({
            actionStatus: "正在连接微信登录…",
            busy: true,
            error: "",
            loginMode: "WECHAT",
        });
        try {
            const session = this.returnPath ? await (0, auth_1.loginWithWechat)()
                : (_a = (0, auth_1.getStoredSession)()) !== null && _a !== void 0 ? _a : (await (0, auth_1.loginWithWechat)());
            // Paying for a friend needs this app's real WeChat identity, not their
            // phone number. All original booking/customer phone guards stay intact.
            if (this.returnPath || !(0, auth_1.needsPhoneVerification)(session)) {
                this.setData({ completed: true, wechatReady: true });
                wx.showToast({ title: "账号已登录", icon: "success" });
                return;
            }
            this.setData({ wechatReady: true, phoneFocused: false });
            wx.showToast({ title: "微信授权成功，请验证手机号", icon: "none" });
            this.setData({ actionStatus: "微信授权已完成，请一键验证手机号" });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "微信授权登录失败";
            this.setData({
                actionStatus: "微信授权未完成",
                error: message,
            });
            wx.showModal({
                title: "微信登录未完成",
                content: message,
                confirmText: "我知道了",
                showCancel: false,
            });
        }
        finally {
            this.setData({ busy: false, loginMode: "" });
        }
    },
    async authorizeWechatPhone(event) {
        var _a, _b;
        if (this.data.busy || !this.ensureAgreementAccepted())
            return;
        const code = (_a = event.detail.code) === null || _a === void 0 ? void 0 : _a.trim();
        if (!code) {
            const cancelled = /deny|cancel/i.test((_b = event.detail.errMsg) !== null && _b !== void 0 ? _b : "");
            const message = cancelled
                ? "你已取消微信手机号授权，可重试或改用短信验证码"
                : "微信未返回手机号授权凭证，请重试或改用短信验证码";
            this.setData({
                actionStatus: "微信手机号未验证",
                error: message,
            });
            wx.showToast({ title: message, icon: "none" });
            return;
        }
        if (!(0, auth_1.getStoredSession)()) {
            this.setData({
                actionStatus: "",
                wechatReady: false,
                error: "微信登录已失效，请先重新完成微信授权",
            });
            wx.showToast({ title: "请先重新完成微信授权", icon: "none" });
            return;
        }
        this.setData({
            actionStatus: "正在验证微信手机号…",
            busy: true,
            error: "",
            loginMode: "WECHAT_PHONE",
        });
        try {
            const result = await (0, auth_1.verifyWechatPhone)(code);
            this.setData({
                completed: true,
                maskedPhone: result.maskedPhone,
                actionStatus: "微信手机号验证完成",
            });
            wx.showToast({ title: "登录成功", icon: "success" });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "微信手机号验证失败";
            this.setData({
                actionStatus: "微信手机号未验证",
                error: message,
            });
            wx.showModal({
                title: "微信手机号验证失败",
                content: `${message}。你也可以改用短信验证码。`,
                confirmText: "我知道了",
                showCancel: false,
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
            const message = "请输入正确的 11 位手机号";
            this.setData({ actionStatus: "", error: message });
            wx.showToast({ title: message, icon: "none" });
            return;
        }
        if (!(0, auth_1.getStoredSession)()) {
            this.setData({
                actionStatus: "",
                wechatReady: false,
                error: "微信登录已失效，请先重新完成微信授权",
            });
            wx.showToast({ title: "请先重新完成微信授权", icon: "none" });
            return;
        }
        this.setData({
            actionStatus: "正在请求短信验证码…",
            busy: true,
            error: "",
            loginMode: "SMS",
        });
        wx.showToast({ title: "正在发送验证码", icon: "loading" });
        try {
            const result = await (0, auth_1.requestSmsPhoneVerification)(this.data.phone);
            this.setData({
                smsRequested: true,
                smsCountdown: result.retryAfterSeconds,
                actionStatus: result.status === "UNKNOWN"
                    ? "短信状态待确认，请稍候查看"
                    : "验证码已发送，请查看手机短信",
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
            const message = error instanceof Error ? error.message : "验证码发送失败";
            this.setData({
                actionStatus: "验证码未发送",
                error: message,
            });
            wx.showModal({
                title: "验证码发送失败",
                content: message,
                confirmText: "我知道了",
                showCancel: false,
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
        if (!(0, auth_1.getStoredSession)()) {
            this.setData({
                wechatReady: false,
                error: "微信登录已失效，请先重新完成微信授权",
            });
            return;
        }
        this.setData({
            actionStatus: "正在校验验证码…",
            busy: true,
            error: "",
            loginMode: "SMS",
        });
        try {
            const result = await (0, auth_1.confirmSmsPhoneVerification)(this.data.phone, this.data.smsCode);
            this.setData({ completed: true, maskedPhone: result.maskedPhone });
            wx.showToast({ title: "登录成功", icon: "success" });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "验证码登录失败";
            this.setData({
                actionStatus: "手机号验证未完成",
                error: message,
            });
            wx.showModal({
                title: "手机号验证失败",
                content: message,
                confirmText: "我知道了",
                showCancel: false,
            });
        }
        finally {
            this.setData({ busy: false, loginMode: "" });
        }
    },
    enterHome() {
        if (this.returnPath) {
            if (!this.data.completed || !(0, auth_1.getStoredSession)())
                return;
            wx.redirectTo({ url: this.returnPath });
            return;
        }
        wx.switchTab({ url: "/pages/home/index" });
    },
    finish() {
        if (this.returnPath) {
            if (!this.data.completed || !(0, auth_1.getStoredSession)())
                return;
            wx.redirectTo({ url: this.returnPath });
            return;
        }
        if (this.data.requiredEntry)
            return;
        wx.navigateBack({ delta: 1 });
    },
});

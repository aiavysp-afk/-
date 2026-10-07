import {
  confirmSmsPhoneVerification,
  getStoredSession,
  loginWithWechat,
  needsPhoneVerification,
  requestSmsPhoneVerification,
  verifyWechatPhone,
} from "../../utils/auth";

type LoginMode = "" | "QUICK" | "SMS";

Page({
  data: {
    accepted: true,
    busy: false,
    codeFocused: false,
    completed: false,
    error: "",
    loginMode: "" as LoginMode,
    maskedPhone: "",
    phone: "",
    phoneFocused: false,
    smsCode: "",
    smsCountdown: 0,
    smsRequested: false,
  },
  countdownTimer: undefined as number | undefined,
  onLoad() {
    const session = getStoredSession();
    if (session && !needsPhoneVerification(session)) {
      this.setData({ completed: true });
    }
  },
  onUnload() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  },
  async ensureWechatSession() {
    return getStoredSession() ?? loginWithWechat();
  },
  ensureAgreementAccepted() {
    if (this.data.accepted) return true;
    this.setData({ error: "请先阅读并同意用户协议、隐私政策与上门服务公约" });
    return false;
  },
  async quickLogin(event: { detail: { code?: string; errMsg?: string } }) {
    if (this.data.busy || !this.ensureAgreementAccepted()) return;
    const code = event.detail.code;
    if (!code) {
      this.setData({
        error:
          event.detail.errMsg?.includes("deny") ||
          event.detail.errMsg?.includes("cancel")
            ? "你已取消手机号授权，也可以使用下方短信验证码登录"
            : "微信未返回手机号授权凭证，请重试",
      });
      return;
    }
    this.setData({ busy: true, error: "", loginMode: "QUICK" });
    try {
      await this.ensureWechatSession();
      const result = await verifyWechatPhone(code);
      this.setData({ completed: true, maskedPhone: result.maskedPhone });
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "手机号登录失败",
      });
    } finally {
      this.setData({ busy: false, loginMode: "" });
    }
  },
  updatePhone(event: { detail: { value: string } }) {
    this.setData({
      phone: event.detail.value.replace(/\D/g, "").slice(0, 11),
      error: "",
    });
  },
  updateSmsCode(event: { detail: { value: string } }) {
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
  openAgreement(event: { currentTarget: { dataset: { type?: string } } }) {
    const type = event.currentTarget.dataset.type ?? "user";
    wx.navigateTo({ url: `/pages/agreement/index?type=${type}` });
  },
  async handleSmsAction() {
    if (this.data.smsRequested) await this.confirmSmsCode();
    else await this.requestSmsCode();
  },
  async requestSmsCode() {
    if (
      this.data.busy ||
      this.data.smsCountdown > 0 ||
      !this.ensureAgreementAccepted()
    )
      return;
    if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
      this.setData({ error: "请输入正确的 11 位手机号" });
      return;
    }
    this.setData({ busy: true, error: "", loginMode: "SMS" });
    try {
      await this.ensureWechatSession();
      const result = await requestSmsPhoneVerification(this.data.phone);
      this.setData({
        smsRequested: true,
        smsCountdown: result.retryAfterSeconds,
        error:
          result.status === "UNKNOWN"
            ? "短信请求状态暂未确认，请稍候查看，暂勿重复点击"
            : "",
      });
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = setInterval(() => {
        const next = Math.max(0, this.data.smsCountdown - 1);
        this.setData({ smsCountdown: next });
        if (next === 0 && this.countdownTimer) {
          clearInterval(this.countdownTimer);
          this.countdownTimer = undefined;
        }
      }, 1_000);
      wx.showToast({ title: "验证码已发送", icon: "success" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "验证码发送失败",
      });
    } finally {
      this.setData({ busy: false, loginMode: "" });
    }
  },
  async confirmSmsCode() {
    if (this.data.busy || !this.ensureAgreementAccepted()) return;
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
      const result = await confirmSmsPhoneVerification(
        this.data.phone,
        this.data.smsCode,
      );
      this.setData({ completed: true, maskedPhone: result.maskedPhone });
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "验证码登录失败",
      });
    } finally {
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

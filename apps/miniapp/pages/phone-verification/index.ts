import {
  confirmCustomerSmsLogin,
  getCustomerLoginCapabilities,
  getStoredSession,
  loginCustomerWithWechatPhone,
  loginWithWechat,
  needsPhoneVerification,
  requestCustomerSmsLogin,
  verifyWechatPhone,
} from "../../utils/auth";
import { safeFriendPaymentReturnPath } from "../../utils/friend-payment";
import { safeLoginReturnPath } from "../../utils/login-return";

type LoginMode = "" | "WECHAT" | "WECHAT_PHONE" | "SMS";

const SMS_CLOSED_MESSAGE = "短信登录暂未开通，请使用微信一键登录";
const loginFailureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && /超时|网络|无法连接/.test(error.message)
    ? "网络连接暂时异常，请检查网络后重试"
    : fallback;

Page({
  data: {
    accepted: false,
    actionStatus: "",
    busy: false,
    codeFocused: false,
    completed: false,
    error: "",
    loginMode: "" as LoginMode,
    phone: "",
    phoneFocused: false,
    smsCode: "",
    smsChallengeId: "",
    smsCountdown: 0,
    smsRequested: false,
    smsFormOpen: false,
    smsLoginEnabled: false,
    smsUnavailableReason: SMS_CLOSED_MESSAGE,
    wechatPhoneLoginEnabled: false,
    capabilitiesReady: false,
    capabilitiesLoading: false,
    wechatReady: false,
    requiredEntry: false,
    friendPaymentReturn: false,
    technicianReturn: false,
    staffReturn: false,
  },
  returnPath: "",
  countdownTimer: undefined as number | undefined,
  disposed: false,
  capabilitiesRequest: undefined as Promise<void> | undefined,
  capabilitiesRequestVersion: 0,
  onLoad(options: {
    required?: string;
    returnPath?: string;
    forceChoice?: string;
  }) {
    this.disposed = false;
    this.returnPath = safeLoginReturnPath(options.returnPath);
    this.setData({
      requiredEntry: options.required === "1",
      friendPaymentReturn: Boolean(
        safeFriendPaymentReturnPath(options.returnPath),
      ),
      technicianReturn: this.returnPath.startsWith("/pages/technician-"),
      staffReturn: this.returnPath === "/pages/admin-login/index",
    });
    const session = getStoredSession();
    if (
      !this.data.friendPaymentReturn &&
      options.forceChoice !== "1" &&
      !(
        (this.data.staffReturn || this.data.technicianReturn) &&
        session?.loginMethod === "PHONE_SMS"
      ) &&
      session &&
      !needsPhoneVerification(session)
    ) {
      this.setData({ completed: true, wechatReady: true });
      this.returnToEntry();
      return;
    }
    void this.loadLoginCapabilities();
  },
  onUnload() {
    this.disposed = true;
    this.capabilitiesRequestVersion += 1;
    this.capabilitiesRequest = undefined;
    this.stopSmsCountdown();
  },
  async loadLoginCapabilities() {
    if (this.disposed || this.data.busy) return;
    if (this.capabilitiesRequest) return this.capabilitiesRequest;
    const version = ++this.capabilitiesRequestVersion;
    this.setData({
      capabilitiesReady: false,
      capabilitiesLoading: true,
      wechatPhoneLoginEnabled: false,
      smsLoginEnabled: false,
      error: "",
    });
    const request = this.fetchLoginCapabilities(version);
    this.capabilitiesRequest = request;
    try {
      await request;
    } finally {
      if (this.capabilitiesRequest === request)
        this.capabilitiesRequest = undefined;
    }
  },
  async fetchLoginCapabilities(version: number) {
    try {
      const capabilities = await getCustomerLoginCapabilities();
      if (this.disposed || version !== this.capabilitiesRequestVersion) return;
      this.setData({
        capabilitiesReady: true,
        wechatPhoneLoginEnabled: capabilities.wechatPhoneLoginEnabled === true,
        smsLoginEnabled: capabilities.smsLoginEnabled === true,
        smsUnavailableReason:
          capabilities.smsLoginEnabled === true ? "" : SMS_CLOSED_MESSAGE,
      });
    } catch {
      if (this.disposed || version !== this.capabilitiesRequestVersion) return;
      this.setData({
        capabilitiesReady: true,
        wechatPhoneLoginEnabled: false,
        smsLoginEnabled: false,
        smsUnavailableReason: "登录服务暂时不可用，请稍后重试",
        error: "暂未获取登录服务状态，请检查网络后重试",
      });
    } finally {
      if (!this.disposed && version === this.capabilitiesRequestVersion)
        this.setData({ capabilitiesLoading: false });
    }
  },
  returnToEntry() {
    const session = getStoredSession();
    if (!this.data.completed || !session) return;
    if (this.data.friendPaymentReturn) return;
    if (session.user.phoneVerified !== true) return;
    if (
      (this.data.staffReturn || this.data.technicianReturn) &&
      session.loginMethod === "PHONE_SMS"
    )
      return;
    if (this.returnPath === "/pages/admin-login/index") {
      wx.redirectTo({ url: "/pages/admin-login/index" });
      return;
    }
    if (this.returnPath.startsWith("/pages/technician-")) {
      wx.redirectTo({ url: this.returnPath });
      return;
    }
    wx.switchTab({ url: "/pages/home/index" });
  },
  ensureAgreementAccepted() {
    if (this.data.accepted) return true;
    this.setData({ error: "请先阅读并同意用户协议、隐私政策与上门服务公约" });
    return false;
  },
  handleWechatChoice() {
    this.ensureAgreementAccepted();
  },
  openSmsLogin() {
    if (
      this.data.busy ||
      this.data.friendPaymentReturn ||
      this.data.staffReturn ||
      this.data.technicianReturn
    )
      return;
    this.setData({ smsFormOpen: true, actionStatus: "", error: "" });
  },
  // Friend-payment only confirms this app's real WeChat identity. It does not
  // collect the payer's phone number or transfer order ownership.
  async authorizeWechat() {
    if (this.data.busy || !this.ensureAgreementAccepted()) return;
    if (!this.data.friendPaymentReturn) return;
    this.setData({
      actionStatus: "正在确认微信身份…",
      busy: true,
      error: "",
      loginMode: "WECHAT",
    });
    try {
      await loginWithWechat();
      if (this.disposed) return;
      this.setData({
        completed: true,
        wechatReady: true,
        actionStatus: "微信身份已确认",
      });
      wx.showToast({ title: "账号已登录", icon: "success" });
    } catch (error) {
      if (this.disposed) return;
      this.setData({
        actionStatus: "微信登录未完成",
        error: loginFailureMessage(error, "微信登录暂未完成，请重试"),
      });
    } finally {
      if (!this.disposed) this.setData({ busy: false, loginMode: "" });
    }
  },
  async authorizeWechatPhone(event: {
    detail: { code?: string; errMsg?: string };
  }) {
    if (this.data.busy || !this.ensureAgreementAccepted()) return;
    if (this.data.friendPaymentReturn) return;
    const code = event.detail.code?.trim();
    if (!code) {
      const cancelled = /deny|cancel/i.test(event.detail.errMsg ?? "");
      const message = cancelled
        ? "你已取消微信手机号授权，请重新点击微信一键登录"
        : "微信未返回手机号授权凭证，请重新点击微信一键登录";
      this.setData({ actionStatus: "微信登录未完成", error: message });
      wx.showToast({ title: message, icon: "none" });
      return;
    }
    if (!this.data.capabilitiesReady || !this.data.wechatPhoneLoginEnabled) {
      this.setData({ error: "微信手机号登录暂时不可用，请稍后重试" });
      return;
    }
    this.setData({
      actionStatus: "正在安全登录…",
      busy: true,
      error: "",
      loginMode: "WECHAT_PHONE",
    });
    try {
      if (this.data.staffReturn || this.data.technicianReturn) {
        // Keep the original staff/technician WeChat subject. Customer phone
        // consolidation must never rebind an elevated or applicant identity.
        let session = getStoredSession();
        if (
          !session ||
          !needsPhoneVerification(session) ||
          session.loginMethod === "PHONE_SMS"
        )
          session = await loginWithWechat();
        if (this.disposed) return;
        if (needsPhoneVerification(session)) await verifyWechatPhone(code);
      } else {
        await loginCustomerWithWechatPhone(code, this.data.accepted);
      }
      if (this.disposed) return;
      if (getStoredSession()?.user.phoneVerified !== true)
        throw new Error("手机号验证未完成");
      this.setData({
        completed: true,
        wechatReady: true,
        actionStatus: "登录成功",
      });
      wx.showToast({ title: "登录成功", icon: "success" });
      this.returnToEntry();
    } catch (error) {
      if (this.disposed) return;
      this.setData({
        actionStatus: "微信登录未完成",
        error: loginFailureMessage(
          error,
          "微信登录暂未完成，请重试或联系平台客服",
        ),
      });
    } finally {
      if (!this.disposed) this.setData({ busy: false, loginMode: "" });
    }
  },
  updatePhone(event: { detail: { value: string } }) {
    if (this.data.busy) return;
    const phone = event.detail.value.replace(/\D/g, "").slice(0, 11);
    if (phone !== this.data.phone) {
      this.stopSmsCountdown();
      this.setData({
        phone,
        smsCode: "",
        smsChallengeId: "",
        smsRequested: false,
        smsCountdown: 0,
        actionStatus: "",
        error: "",
      });
    }
  },
  updateSmsCode(event: { detail: { value: string } }) {
    if (this.data.busy) return;
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
    if (this.data.busy) return;
    this.setData({ accepted: !this.data.accepted, error: "" });
  },
  openAgreement(event: { currentTarget: { dataset: { type?: string } } }) {
    const type = event.currentTarget.dataset.type ?? "user";
    if (!["user", "privacy", "service"].includes(type)) return;
    wx.navigateTo({ url: `/pages/agreement/index?type=${type}` });
  },
  ensureSmsLoginAvailable() {
    if (
      this.data.friendPaymentReturn ||
      this.data.staffReturn ||
      this.data.technicianReturn
    )
      return false;
    if (this.data.capabilitiesReady && this.data.smsLoginEnabled) return true;
    this.setData({
      error: this.data.smsUnavailableReason || SMS_CLOSED_MESSAGE,
    });
    return false;
  },
  stopSmsCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  },
  startSmsCountdown(seconds: number) {
    this.stopSmsCountdown();
    this.setData({ smsCountdown: Math.max(1, Math.ceil(seconds)) });
    this.countdownTimer = setInterval(() => {
      const next = Math.max(0, this.data.smsCountdown - 1);
      this.setData({ smsCountdown: next });
      if (next === 0) this.stopSmsCountdown();
    }, 1_000);
  },
  async requestSmsCode() {
    if (
      this.data.busy ||
      this.data.smsCountdown > 0 ||
      !this.ensureAgreementAccepted()
    )
      return;
    if (!this.ensureSmsLoginAvailable()) return;
    if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
      this.setData({ error: "请输入正确的 11 位手机号" });
      return;
    }
    this.setData({
      actionStatus: "正在发送短信验证码…",
      busy: true,
      error: "",
      loginMode: "SMS",
      smsChallengeId: "",
      smsCode: "",
      smsRequested: false,
    });
    try {
      const result = await requestCustomerSmsLogin(
        this.data.phone,
        this.data.accepted,
      );
      if (this.disposed) return;
      if (!result.challengeId) throw new Error("未收到短信验证凭证");
      this.setData({
        smsChallengeId: result.challengeId,
        smsRequested: true,
        actionStatus:
          result.status === "UNKNOWN"
            ? "短信发送状态待确认，请稍候查看手机短信"
            : "验证码已发送，请查看手机短信",
      });
      this.startSmsCountdown(result.retryAfterSeconds);
    } catch (error) {
      if (this.disposed) return;
      this.setData({
        actionStatus: "验证码未发送",
        error: loginFailureMessage(error, "验证码暂未发送，请稍后重试"),
      });
    } finally {
      if (!this.disposed) this.setData({ busy: false, loginMode: "" });
    }
  },
  async confirmSmsCode() {
    if (this.data.busy || !this.ensureAgreementAccepted()) return;
    if (!this.ensureSmsLoginAvailable()) return;
    if (!/^1[3-9]\d{9}$/.test(this.data.phone)) {
      this.setData({ error: "请输入正确的 11 位手机号" });
      return;
    }
    if (!this.data.smsRequested || !this.data.smsChallengeId) {
      this.setData({ error: "请先获取此手机号的短信验证码" });
      return;
    }
    if (!/^\d{6}$/.test(this.data.smsCode)) {
      this.setData({ error: "请输入短信中的 6 位验证码" });
      return;
    }
    this.setData({
      actionStatus: "正在安全登录…",
      busy: true,
      error: "",
      loginMode: "SMS",
    });
    try {
      await confirmCustomerSmsLogin(
        this.data.phone,
        this.data.smsCode,
        this.data.smsChallengeId,
        this.data.accepted,
      );
      if (this.disposed) return;
      if (getStoredSession()?.user.phoneVerified !== true)
        throw new Error("手机号验证未完成");
      this.stopSmsCountdown();
      this.setData({
        completed: true,
        actionStatus: "登录成功",
        smsCode: "",
        smsChallengeId: "",
        smsRequested: false,
      });
      wx.showToast({ title: "登录成功", icon: "success" });
      this.returnToEntry();
    } catch (error) {
      if (this.disposed) return;
      this.setData({
        actionStatus: "手机号登录未完成",
        error: loginFailureMessage(
          error,
          "验证码无效或已过期，请重新获取后重试",
        ),
      });
    } finally {
      if (!this.disposed) this.setData({ busy: false, loginMode: "" });
    }
  },
  enterHome() {
    if (!this.data.completed || !getStoredSession()) return;
    if (this.data.friendPaymentReturn) {
      wx.redirectTo({ url: this.returnPath });
      return;
    }
    this.returnToEntry();
  },
  finish() {
    if (this.data.completed) {
      this.enterHome();
      return;
    }
    if (this.data.requiredEntry) return;
    wx.navigateBack({ delta: 1 });
  },
});

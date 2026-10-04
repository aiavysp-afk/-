import {
  clearStoredSession,
  getStoredSession,
  loginWithWechat,
} from "../../utils/auth";
import { api } from "../../utils/api";
import type { PublicConfig } from "@zydj/contracts";
import {
  openWecomCustomerService,
  callEmergencyDuty,
} from "../../utils/customer-service";

// These are public merchant contact channels, not credentials. Keeping a
// compile-time fallback makes emergency/contact access survive API maintenance.
// A successful public-config response remains authoritative and replaces them.
const PUBLIC_CONTACT_FALLBACK = {
  customerService: {
    provider: "wecom",
    available: true,
    corpId: "ww715e0d876d9f3cb4",
    url: "https://work.weixin.qq.com/kfid/kfca6852bf5e57656af",
  },
  emergencyContact: {
    configured: true,
    phone: "18018181799",
  },
} satisfies Pick<PublicConfig, "customerService" | "emergencyContact">;

Page({
  data: {
    menus: ["我的地址", "优惠券", "发票申请", "协议与隐私", "账户与安全"],
    loggedIn: false,
    loggingIn: false,
    displayName: "微信用户",
    customerService:
      PUBLIC_CONTACT_FALLBACK.customerService as PublicConfig["customerService"],
    emergencyContact:
      PUBLIC_CONTACT_FALLBACK.emergencyContact as PublicConfig["emergencyContact"],
  },
  onLoad() {
    const session = getStoredSession();
    if (session)
      this.setData({ loggedIn: true, displayName: session.user.displayName });
  },
  async onShow() {
    // Public, compile-time safety channels remain available during API maintenance.
    // Any successful server response is authoritative and replaces this fallback.
    this.setData({
      customerService: PUBLIC_CONTACT_FALLBACK.customerService,
      emergencyContact: PUBLIC_CONTACT_FALLBACK.emergencyContact,
    });
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({
        customerService: config.customerService,
        emergencyContact: config.emergencyContact,
      });
    } catch {
      /* Unconfigured/unreachable is shown explicitly by the tap handler. */
    }
  },
  openCustomerService() {
    openWecomCustomerService(this.data.customerService);
  },
  callEmergency() {
    callEmergencyDuty(this.data.emergencyContact);
  },
  async login() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });
    try {
      const session = await loginWithWechat();
      this.setData({
        loggedIn: true,
        loggingIn: false,
        displayName: session.user.displayName,
      });
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      this.setData({ loggingIn: false });
      wx.showToast({
        title: error instanceof Error ? error.message : "登录失败",
        icon: "none",
      });
    }
  },
  openAdminLogin() {
    wx.navigateTo({ url: "/pages/admin-login/index" });
  },
  openMfaRecovery() {
    wx.navigateTo({ url: "/pages/mfa-recovery/index" });
  },
  async logout() {
    try {
      await api("/auth/logout", "POST", {});
    } catch {
      wx.showToast({ title: "服务端注销未确认，请稍后重试", icon: "none" });
      return;
    }
    clearStoredSession();
    this.setData({ loggedIn: false, displayName: "微信用户" });
    wx.showToast({ title: "会话已安全注销", icon: "success" });
  },
});

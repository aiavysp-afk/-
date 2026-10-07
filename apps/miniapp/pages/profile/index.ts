import {
  clearStoredSession,
  goToPhoneVerification,
  getStoredSession,
  loginWithWechat,
  needsPhoneVerification,
} from "../../utils/auth";
import { api } from "../../utils/api";
import type { OrderView, PublicConfig } from "@zydj/contracts";
import {
  openWecomCustomerService,
  callEmergencyDuty,
} from "../../utils/customer-service";
import { syncCustomTabBar } from "../../utils/tab-bar";

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
    loggedIn: false,
    phoneVerified: false,
    loggingIn: false,
    displayName: "微信用户",
    stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
    customerService:
      PUBLIC_CONTACT_FALLBACK.customerService as PublicConfig["customerService"],
    emergencyContact:
      PUBLIC_CONTACT_FALLBACK.emergencyContact as PublicConfig["emergencyContact"],
  },
  onLoad() {
    const session = getStoredSession();
    if (session)
      this.setData({
        loggedIn: true,
        phoneVerified: session.user.phoneVerified === true,
        displayName: session.user.displayName,
      });
  },
  async onShow() {
    syncCustomTabBar(this, 4);
    const session = getStoredSession();
    this.setData({
      loggedIn: Boolean(session),
      phoneVerified: session?.user.phoneVerified === true,
      displayName: session?.user.displayName ?? "微信用户",
    });
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
    if (session) await this.loadStats();
  },
  async loadStats() {
    try {
      const orders = await api<OrderView[]>("/orders");
      this.setData({
        stats: {
          upcoming: orders.filter((order) =>
            ["PAID", "DISPATCHING", "ASSIGNED", "EN_ROUTE", "ARRIVED"].includes(
              order.status,
            ),
          ).length,
          active: orders.filter((order) => order.status === "IN_SERVICE")
            .length,
          confirmation: orders.filter(
            (order) => order.status === "AWAITING_CONFIRMATION",
          ).length,
          afterSale: orders.filter((order) =>
            ["REFUNDING", "REFUNDED"].includes(order.status),
          ).length,
        },
      });
    } catch {
      this.setData({
        stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
      });
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
        phoneVerified: session.user.phoneVerified === true,
        loggingIn: false,
        displayName: session.user.displayName,
      });
      wx.showToast({ title: "登录成功", icon: "success" });
      if (needsPhoneVerification(session)) {
        goToPhoneVerification();
        return;
      }
      await this.loadStats();
    } catch (error) {
      this.setData({ loggingIn: false });
      wx.showToast({
        title: error instanceof Error ? error.message : "登录失败",
        icon: "none",
      });
    }
  },
  verifyPhone() {
    goToPhoneVerification();
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
    this.setData({
      loggedIn: false,
      phoneVerified: false,
      displayName: "微信用户",
      stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
    });
    wx.showToast({ title: "会话已安全注销", icon: "success" });
  },
});

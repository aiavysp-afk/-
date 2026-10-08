import {
  clearStoredSession,
  goToPhoneVerification,
  getStoredSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { api } from "../../utils/api";
import type { OrderView, PublicConfig } from "@zydj/contracts";
import { callEmergencyDuty } from "../../utils/customer-service";
import { syncCustomTabBar } from "../../utils/tab-bar";

// These are public merchant contact channels, not credentials. Keeping a
// compile-time fallback makes emergency/contact access survive API maintenance.
// A successful public-config response remains authoritative and replaces them.
const PUBLIC_CONTACT_FALLBACK = {
  emergencyContact: {
    configured: true,
    phone: "18018181799",
  },
} satisfies Pick<PublicConfig, "emergencyContact">;

Page({
  data: {
    loggedIn: false,
    phoneVerified: false,
    displayName: "微信用户",
    stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
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
    if (!requireVerifiedCustomerAccess()) return;
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
      emergencyContact: PUBLIC_CONTACT_FALLBACK.emergencyContact,
    });
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({
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
  callEmergency() {
    callEmergencyDuty(this.data.emergencyContact);
  },
  openLogin() {
    goToPhoneVerification();
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

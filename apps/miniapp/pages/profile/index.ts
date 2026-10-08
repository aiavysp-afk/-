import type {
  CustomerCenterOverview,
  OrderView,
  PublicConfig,
} from "@zydj/contracts";
import { api } from "../../utils/api";
import { callEmergencyDuty } from "../../utils/customer-service";
import { loadCustomerCenterOverview } from "../../utils/customer-center";
import {
  getStoredSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";

const DEFAULT_CONTENT = {
  levelLabel: "中原到家用户",
  cityNewsTitle: "城市快讯",
  cityNewsContent: "中原到家持续为郑州用户提供规范上门服务",
  appBannerTitle: "中原到家小程序",
  appBannerSubtitle: "无需下载 APP，微信内即可预约",
  appDownloadUrl: null as string | null,
  safeguardItems: ["价格透明", "服务留痕", "售后保障"],
};

const PUBLIC_CONTACT_FALLBACK = {
  emergencyContact: { configured: true, phone: "18018181799" },
} satisfies Pick<PublicConfig, "emergencyContact">;

const emptyCounts = () => ({
  pendingPayment: 0,
  inProgress: 0,
  pendingReview: 0,
  cancelled: 0,
});

Page({
  data: {
    loading: false,
    error: "",
    displayName: "微信用户",
    avatarUrl: "",
    avatarText: "客",
    levelLabel: DEFAULT_CONTENT.levelLabel,
    availableCouponCount: 0,
    availableCardCount: 0,
    maskedBalance: "****",
    orders: emptyCounts(),
    totalOrderCount: 0,
    cityNewsTitle: DEFAULT_CONTENT.cityNewsTitle,
    cityNewsContent: DEFAULT_CONTENT.cityNewsContent,
    appBannerTitle: DEFAULT_CONTENT.appBannerTitle,
    appBannerSubtitle: DEFAULT_CONTENT.appBannerSubtitle,
    appDownloadUrl: DEFAULT_CONTENT.appDownloadUrl,
    safeguardItems: DEFAULT_CONTENT.safeguardItems,
    emergencyContact:
      PUBLIC_CONTACT_FALLBACK.emergencyContact as PublicConfig["emergencyContact"],
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    syncCustomTabBar(this, 4);
    const session = getStoredSession();
    const displayName = session?.user.displayName || "微信用户";
    this.setData({
      displayName,
      avatarText: displayName.trim().slice(0, 1) || "客",
    });
    await Promise.all([this.load(), this.loadPublicContact()]);
  },
  async loadPublicContact() {
    this.setData({
      emergencyContact: PUBLIC_CONTACT_FALLBACK.emergencyContact,
    });
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({ emergencyContact: config.emergencyContact });
    } catch {
      // The confirmed public emergency fallback remains available in maintenance.
    }
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const overview = await loadCustomerCenterOverview();
      this.applyOverview(overview);
    } catch (error) {
      this.setData({
        error:
          error instanceof Error
            ? `个人中心部分数据暂未加载：${error.message}`
            : "个人中心部分数据暂未加载",
      });
      await this.loadOrderFallback();
    } finally {
      this.setData({ loading: false });
    }
  },
  applyOverview(overview: CustomerCenterOverview) {
    const displayName = overview.profile.displayName || "微信用户";
    const totalOrderCount = Object.values(overview.orders).reduce(
      (sum, value) => sum + value,
      0,
    );
    this.setData({
      displayName,
      avatarUrl: overview.profile.avatarUrl || "",
      avatarText: displayName.trim().slice(0, 1) || "客",
      levelLabel: overview.profile.levelLabel,
      availableCouponCount: overview.benefits.availableCouponCount,
      availableCardCount: overview.benefits.availableCardCount,
      maskedBalance: overview.benefits.maskedBalance,
      orders: overview.orders,
      totalOrderCount,
      cityNewsTitle: overview.content.cityNewsTitle,
      cityNewsContent: overview.content.cityNewsContent,
      appBannerTitle: overview.content.appBannerTitle,
      appBannerSubtitle: overview.content.appBannerSubtitle,
      appDownloadUrl: overview.content.appDownloadUrl,
      safeguardItems:
        overview.content.safeguardItems.length > 0
          ? overview.content.safeguardItems
          : DEFAULT_CONTENT.safeguardItems,
    });
  },
  async loadOrderFallback() {
    try {
      const rows = await api<OrderView[]>("/orders");
      const orders = {
        pendingPayment: rows.filter(
          (order) => order.status === "PENDING_PAYMENT",
        ).length,
        inProgress: rows.filter((order) =>
          [
            "PAID",
            "DISPATCHING",
            "ASSIGNED",
            "EN_ROUTE",
            "ARRIVED",
            "IN_SERVICE",
            "AWAITING_CONFIRMATION",
          ].includes(order.status),
        ).length,
        pendingReview: rows.filter(
          (order) =>
            order.status === "COMPLETED" && order.reviewStatus === null,
        ).length,
        cancelled: rows.filter((order) =>
          ["CANCELLED", "REFUNDED"].includes(order.status),
        ).length,
      };
      this.setData({
        orders,
        totalOrderCount: Object.values(orders).reduce(
          (sum, value) => sum + value,
          0,
        ),
      });
    } catch {
      this.setData({ orders: emptyCounts(), totalOrderCount: 0 });
    }
  },
  openSettings() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },
  openCoupons() {
    wx.navigateTo({ url: "/pages/coupons/index" });
  },
  openStoredValue() {
    wx.navigateTo({ url: "/pages/stored-value/index" });
  },
  openOrders() {
    wx.navigateTo({ url: "/pages/orders/index" });
  },
  openOrderFilter(event: { currentTarget: { dataset: { status: string } } }) {
    const status = event.currentTarget.dataset.status;
    wx.navigateTo({
      url: `/pages/orders/index?status=${encodeURIComponent(status)}`,
    });
  },
  openRecord(event: { currentTarget: { dataset: { kind: string } } }) {
    wx.navigateTo({
      url: `/pages/customer-records/index?kind=${encodeURIComponent(
        event.currentTarget.dataset.kind,
      )}`,
    });
  },
  quickOrder() {
    wx.switchTab({ url: "/pages/services/index" });
  },
  callEmergency() {
    callEmergencyDuty(this.data.emergencyContact);
  },
  openAppBanner() {
    const url = this.data.appDownloadUrl;
    if (!url) {
      wx.showModal({
        title: this.data.appBannerTitle,
        content: `${this.data.appBannerSubtitle}\n\n当前无需下载 APP，可直接在微信小程序完成预约。`,
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: "打开官方地址",
      content:
        "小程序内不能直接安装 APP，可复制经后台配置并校验的官方 HTTPS 地址后，在浏览器中打开。",
      confirmText: "复制地址",
      success: (result) => {
        if (result.confirm) wx.setClipboardData({ data: url });
      },
    });
  },
});

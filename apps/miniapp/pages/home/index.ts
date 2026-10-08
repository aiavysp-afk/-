import type { PublicConfig, ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import {
  hasVerifiedCustomerSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";

type HomeService = ServiceItem & {
  duration: string;
  price: string;
  tone: "sage" | "tea" | "clay";
};

Page({
  data: {
    services: [] as HomeService[],
    loading: false,
    error: "",
    serviceCity: "郑州市",
    accessReady: false,
  },
  async onShow() {
    this.setData({ accessReady: hasVerifiedCustomerSession() });
    syncCustomTabBar(this, 0);
    await Promise.all([this.loadServices(), this.loadPublicConfig()]);
  },
  async loadServices() {
    this.setData({ loading: true, error: "" });
    try {
      const services = await api<ServiceItem[]>("/catalog/services");
      this.setData({
        services: services.slice(0, 3).map((service, index) => ({
          ...service,
          duration: `${service.durationMinutes} 分钟`,
          price: money(service.priceFen),
          tone: (["sage", "tea", "clay"] as const)[index % 3]!,
        })),
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "服务目录加载失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  async loadPublicConfig() {
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({ serviceCity: config.serviceCity });
    } catch {
      // The city fallback remains visible while the public API is unavailable.
    }
  },
  chooseAddress() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.switchTab({ url: "/pages/services/index" });
  },
  bookNow() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.switchTab({ url: "/pages/services/index" });
  },
  openServices() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.switchTab({ url: "/pages/services/index" });
  },
  openTherapists() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.switchTab({ url: "/pages/therapists/index" });
  },
  openOrders() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.switchTab({ url: "/pages/orders/index" });
  },
  requireAccess() {
    requireVerifiedCustomerAccess();
  },
  retryServices() {
    if (!requireVerifiedCustomerAccess()) return;
    void this.loadServices();
  },
  bookService(e: { currentTarget: { dataset: { slug?: string } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    const slug = e.currentTarget.dataset.slug;
    if (!slug) return;
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(slug)}`,
    });
  },
});

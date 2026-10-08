import type { PublicConfig, ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
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
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
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
    wx.switchTab({ url: "/pages/services/index" });
  },
  bookNow() {
    wx.switchTab({ url: "/pages/services/index" });
  },
  bookService(e: { currentTarget: { dataset: { slug?: string } } }) {
    const slug = e.currentTarget.dataset.slug;
    if (!slug) return;
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(slug)}`,
    });
  },
});

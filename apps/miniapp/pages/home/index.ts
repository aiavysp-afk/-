import type { PublicConfig, ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import {
  hasVerifiedCustomerSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
import { getGcj02Location, reverseGeocode } from "../../utils/amap";

type HomeService = ServiceItem & {
  duration: string;
  price: string;
  tone: "sage" | "tea" | "clay";
  categoryLabel: string;
};

const categoryLabels: Record<ServiceItem["category"], string> = {
  MASSAGE: "按摩舒缓",
  SPA_RELAXATION: "SPA 放松",
  FOOT_CARE: "足部养护",
};

Page({
  data: {
    services: [] as HomeService[],
    loading: false,
    error: "",
    serviceCity: "郑州市",
    locationLabel: "正在获取当前位置…",
    locationBusy: false,
    locationError: "",
    amapMiniappKey: "",
    autoLocationTried: false,
    accessReady: false,
  },
  async onShow() {
    this.setData({ accessReady: hasVerifiedCustomerSession() });
    syncCustomTabBar(this, 0);
    await Promise.all([this.loadServices(), this.prepareLocation()]);
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
          categoryLabel: categoryLabels[service.category],
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
      this.setData({
        serviceCity: config.serviceCity,
        amapMiniappKey: config.map.miniappKey,
      });
      return config;
    } catch {
      // The city fallback remains visible while the public API is unavailable.
      return null;
    }
  },
  async prepareLocation() {
    await this.loadPublicConfig();
    if (!this.data.autoLocationTried) await this.locateCity();
  },
  async locateCity() {
    if (this.data.locationBusy) return;
    this.setData({
      locationBusy: true,
      locationError: "",
      autoLocationTried: true,
      locationLabel: "正在获取当前位置…",
    });
    try {
      const point = await getGcj02Location();
      const address = await reverseGeocode(this.data.amapMiniappKey, point);
      this.setData({
        locationLabel: `已定位 · ${address.detail.slice(0, 18)}`,
      });
    } catch (error) {
      this.setData({
        locationLabel: `${this.data.serviceCity}全域服务`,
        locationError:
          error instanceof Error ? error.message : "当前位置获取失败",
      });
    } finally {
      this.setData({ locationBusy: false });
    }
  },
  chooseAddress() {
    if (this.data.locationError) {
      void this.locateCity();
      return;
    }
    if (!requireVerifiedCustomerAccess()) return;
    wx.navigateTo({ url: "/pages/addresses/index" });
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
    wx.navigateTo({ url: "/pages/therapists/index" });
  },
  openOrders() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.navigateTo({ url: "/pages/orders/index" });
  },
  openNewcomer() {
    if (!requireVerifiedCustomerAccess()) return;
    wx.navigateTo({ url: "/pages/coupons/index" });
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

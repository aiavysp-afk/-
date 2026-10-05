import type { PublicConfig, ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import { openWecomCustomerService } from "../../utils/customer-service";

type HomeService = ServiceItem & {
  duration: string;
  price: string;
  tone: "sage" | "tea" | "clay";
};

const CUSTOMER_SERVICE_FALLBACK: PublicConfig["customerService"] = {
  provider: "wecom",
  available: true,
  corpId: "ww715e0d876d9f3cb4",
  url: "https://work.weixin.qq.com/kfid/kfca6852bf5e57656af",
};

Page({
  data: {
    services: [] as HomeService[],
    loading: false,
    error: "",
    serviceCity: "郑州市",
    customerService: CUSTOMER_SERVICE_FALLBACK,
  },
  async onShow() {
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
    this.setData({ customerService: CUSTOMER_SERVICE_FALLBACK });
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({
        serviceCity: config.serviceCity,
        customerService: config.customerService,
      });
    } catch {
      // The verified public customer-service fallback remains usable during API maintenance.
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
  callSupport() {
    openWecomCustomerService(this.data.customerService);
  },
});

import type { ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
import {
  loadPublicTherapists,
  type PublicTherapistView,
} from "../../utils/therapists";

type ServiceCard = ServiceItem & { price: string; tone: number };

Page({
  data: {
    tabs: ["推荐", "服务项目", "技师风采", "安心保障"],
    activeTab: 0,
    services: [] as ServiceCard[],
    therapists: [] as PublicTherapistView[],
    loading: false,
    error: "",
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    syncCustomTabBar(this, 1);
    if (!this.data.services.length && !this.data.therapists.length)
      await this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [servicesResult, therapistsResult] = await Promise.allSettled([
        api<ServiceItem[]>("/catalog/services"),
        loadPublicTherapists(),
      ]);
      const services =
        servicesResult.status === "fulfilled"
          ? servicesResult.value.slice(0, 6).map((service, index) => ({
              ...service,
              price: money(service.priceFen),
              tone: index % 4,
            }))
          : [];
      const therapists =
        therapistsResult.status === "fulfilled"
          ? therapistsResult.value.slice(0, 6)
          : [];
      this.setData({ services, therapists });
      if (!services.length && !therapists.length)
        throw new Error("暂无已发布的服务或技师资料");
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "发现内容读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  selectTab(event: { currentTarget: { dataset: { index: number } } }) {
    this.setData({ activeTab: Number(event.currentTarget.dataset.index) });
  },
  openService(event: { currentTarget: { dataset: { slug: string } } }) {
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(
        event.currentTarget.dataset.slug,
      )}`,
    });
  },
  openTherapist(event: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({
      url: `/pages/therapist-detail/index?id=${encodeURIComponent(
        event.currentTarget.dataset.id,
      )}`,
    });
  },
  openAllServices() {
    wx.switchTab({ url: "/pages/services/index" });
  },
  openAllTherapists() {
    wx.navigateTo({ url: "/pages/therapists/index" });
  },
});

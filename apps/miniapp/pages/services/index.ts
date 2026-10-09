import type { ServiceItem } from "@zydj/contracts";
import { money } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
import {
  loadPublicServiceDiscovery,
  serviceBookingState,
  serviceBookingLabel,
  serviceBookingAction,
  type ServiceBookingState,
} from "../../utils/service-discovery";
type Card = ServiceItem & {
  price: string;
  therapistId: string;
  bookableCount: number;
  bookingState: ServiceBookingState;
  bookingLabel: string;
  bookingAction: string;
};
Page({
  data: {
    categories: ["全部", "按摩舒缓", "SPA 放松", "足部养护"],
    active: 0,
    all: [] as Card[],
    services: [] as Card[],
    loading: false,
    error: "",
    scheduleError: "",
    showEmptyServices: false,
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    syncCustomTabBar(this, 2);
    await this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({
      loading: true,
      error: "",
      scheduleError: "",
      showEmptyServices: false,
      all: [],
      services: [],
    });
    try {
      const snapshot = await loadPublicServiceDiscovery();
      const all = snapshot.services.map((item) => {
        const availability = serviceBookingState(item.id, snapshot);
        return {
          ...item,
          price: money(item.priceFen),
          ...availability,
          bookingLabel: serviceBookingLabel(availability.bookingState),
          bookingAction: serviceBookingAction(availability.bookingState),
        };
      });
      this.setData({
        all,
        scheduleError: snapshot.failedServiceIds.length
          ? "部分项目排班读取失败，请重试确认可约状态。"
          : "",
      });
      this.filter();
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "目录加载失败",
      });
    } finally {
      this.setData({
        loading: false,
        showEmptyServices: !this.data.error && this.data.services.length === 0,
      });
    }
  },
  select(e: { currentTarget: { dataset: { index: number } } }) {
    this.setData({ active: Number(e.currentTarget.dataset.index) });
    this.filter();
  },
  filter() {
    const category = ["", "MASSAGE", "SPA_RELAXATION", "FOOT_CARE"][
      this.data.active
    ];
    const services = this.data.all.filter(
      (item) => !category || item.category === category,
    );
    this.setData({
      services,
      showEmptyServices:
        !this.data.loading && !this.data.error && services.length === 0,
    });
  },
  book(e: { currentTarget: { dataset: { slug: string } } }) {
    if (!requireVerifiedCustomerAccess() || this.data.loading) return;
    const service = this.data.all.find(
      (item) => item.slug === e.currentTarget.dataset.slug,
    );
    if (!service) return;
    if (service.bookingState === "ERROR") {
      void this.load();
      return;
    }
    if (!service.therapistId) {
      wx.showToast({
        title:
          service.bookingState === "NO_PROFILE"
            ? "技师资料审核发布后即可预约"
            : "该项目当前未开放预约时段",
        icon: "none",
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/therapist-detail/index?id=${encodeURIComponent(service.therapistId)}&slug=${encodeURIComponent(service.slug)}`,
    });
  },
});

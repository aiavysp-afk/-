import { requireVerifiedCustomerAccess } from "../../utils/auth";
import {
  loadPublicTherapists,
  type PublicTherapistView,
  type TherapistServiceView,
} from "../../utils/therapists";

Page({
  data: {
    activeFilter: "ALL" as "ALL" | "TODAY" | "TOMORROW",
    bookingOpen: false,
    error: "",
    filters: [
      { key: "ALL", label: "全部技师" },
      { key: "TODAY", label: "今日可约" },
      { key: "TOMORROW", label: "明日可约" },
    ],
    loading: false,
    selectedTherapist: null as PublicTherapistView | null,
    therapists: [] as PublicTherapistView[],
    visibleTherapists: [] as PublicTherapistView[],
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    await this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    try {
      const therapists = await loadPublicTherapists();
      this.setData({ therapists });
      this.applyFilter();
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "技师排班读取失败",
        therapists: [],
        visibleTherapists: [],
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  selectFilter(event: {
    currentTarget: { dataset: { key: "ALL" | "TODAY" | "TOMORROW" } };
  }) {
    this.setData({ activeFilter: event.currentTarget.dataset.key });
    this.applyFilter();
  },
  applyFilter() {
    const visibleTherapists = this.data.therapists.filter((therapist) => {
      if (this.data.activeFilter === "TODAY")
        return therapist.todaySlotCount > 0;
      if (this.data.activeFilter === "TOMORROW")
        return therapist.tomorrowSlotCount > 0;
      return true;
    });
    this.setData({ visibleTherapists });
  },
  openDetail(event: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({
      url: `/pages/therapist-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`,
    });
  },
  openBooking(event: { currentTarget: { dataset: { id: string } } }) {
    const selectedTherapist = this.data.therapists.find(
      (therapist) => therapist.id === event.currentTarget.dataset.id,
    );
    if (!selectedTherapist?.bookable) {
      wx.showToast({ title: "该技师当前暂无可约时段", icon: "none" });
      return;
    }
    this.setData({ selectedTherapist, bookingOpen: true });
  },
  closeBooking() {
    this.setData({ bookingOpen: false, selectedTherapist: null });
  },
  keepBookingOpen() {},
  chooseService(event: { currentTarget: { dataset: { slug: string } } }) {
    const therapist = this.data.selectedTherapist;
    const service = therapist?.services.find(
      (item: TherapistServiceView) =>
        item.slug === event.currentTarget.dataset.slug,
    );
    if (!therapist || !service) return;
    this.closeBooking();
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(service.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
    });
  },
});

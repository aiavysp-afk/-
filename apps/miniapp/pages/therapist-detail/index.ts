import {
  loadPublicTherapist,
  type PublicTherapistDetailView,
} from "../../utils/therapists";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

Page({
  data: {
    error: "",
    loading: true,
    therapist: null as PublicTherapistDetailView | null,
  },
  async onLoad(options: { id?: string }) {
    if (!requireVerifiedCustomerAccess()) return;
    if (!options.id) {
      this.setData({ error: "缺少技师参数", loading: false });
      return;
    }
    try {
      const therapist = await loadPublicTherapist(options.id);
      this.setData({ therapist });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "技师资料读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  book(event: { currentTarget: { dataset: { slug: string } } }) {
    const therapist = this.data.therapist;
    if (!therapist) return;
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(event.currentTarget.dataset.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
    });
  },
});

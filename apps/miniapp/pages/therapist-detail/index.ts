import {
  loadPublicTherapists,
  type PublicTherapistView,
} from "../../utils/therapists";

Page({
  data: {
    error: "",
    loading: true,
    therapist: null as PublicTherapistView | null,
  },
  async onLoad(options: { id?: string }) {
    if (!options.id) {
      this.setData({ error: "缺少技师参数", loading: false });
      return;
    }
    try {
      const therapists = await loadPublicTherapists();
      const therapist = therapists.find((item) => item.id === options.id);
      if (!therapist) throw new Error("该技师当前没有公开可约排班");
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

import {
  loadPublicTherapist,
  type PublicTherapistDetailView,
} from "../../utils/therapists";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import { canUploadOwnTechnicianPhotos, refreshOwnTechnicianPhotoAccess } from "../../utils/technician-photos";

Page({
  data: {
    error: "",
    loading: true,
    canUploadOwnPhotos: false,
    therapist: null as PublicTherapistDetailView | null,
    selectedServiceSlug: "",
    selectedServiceName: "",
  },
  async onLoad(options: { id?: string; slug?: string }) {
    if (!requireVerifiedCustomerAccess()) return;
    this.setData({ canUploadOwnPhotos: canUploadOwnTechnicianPhotos() });
    void refreshOwnTechnicianPhotoAccess().then((allowed) => this.setData({ canUploadOwnPhotos: allowed })).catch(() => this.setData({ canUploadOwnPhotos: false }));
    if (!options.id) {
      this.setData({ error: "缺少技师参数", loading: false });
      return;
    }
    try {
      const therapist = await loadPublicTherapist(options.id);
      const selected = options.slug
        ? therapist.services.find((service) => service.slug === options.slug)
        : undefined;
      if (options.slug && !selected) {
        wx.showToast({ title: "所选项目当前暂无可约时间", icon: "none" });
      }
      this.setData({
        therapist: {
          ...therapist,
          // Keep the selected real service first without removing other services.
          services: selected
            ? [
                selected,
                ...therapist.services.filter(
                  (service) => service.slug !== selected.slug,
                ),
              ]
            : therapist.services,
        },
        selectedServiceSlug: selected?.slug ?? "",
        selectedServiceName: selected?.name ?? "",
      });
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
  openOwnPhotos() {
    if (!requireVerifiedCustomerAccess() || !this.data.canUploadOwnPhotos) return;
    wx.navigateTo({ url: "/pages/technician-photos/index" });
  },
  book(event: { currentTarget: { dataset: { slug: string } } }) {
    const therapist = this.data.therapist;
    if (!therapist || !requireVerifiedCustomerAccess()) return;
    const service = therapist.services.find(
      (item) => item.slug === event.currentTarget.dataset.slug,
    );
    if (!service?.slots.length) {
      wx.showToast({ title: "该项目当前暂无可约时间", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/booking/index?slug=${encodeURIComponent(event.currentTarget.dataset.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
    });
  },
});

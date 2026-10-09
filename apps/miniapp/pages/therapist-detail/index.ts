import {
  loadPublicTherapist,
  type PublicTherapistDetailView,
  type TherapistServiceView,
} from "../../utils/therapists";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import {
  canUploadOwnTechnicianPhotos,
  refreshOwnTechnicianPhotoAccess,
} from "../../utils/technician-photos";

type DetailTab = "recommended" | "all" | "reviews" | "updates";

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "recommended", label: "推荐项目" },
  { key: "all", label: "全部项目" },
  { key: "reviews", label: "用户评论" },
  { key: "updates", label: "商户动态" },
];

const recommendedServices = (
  services: TherapistServiceView[],
  selectedSlug: string,
) =>
  services.filter((service) => service.featured || service.slug === selectedSlug);

Page({
  data: {
    error: "",
    loading: true,
    canUploadOwnPhotos: false,
    therapist: null as PublicTherapistDetailView | null,
    selectedServiceSlug: "",
    selectedServiceName: "",
    activeTab: "recommended" as DetailTab,
    tabs: DETAIL_TABS,
    displayedServices: [] as TherapistServiceView[],
  },
  async onLoad(options: { id?: string; slug?: string }) {
    if (!requireVerifiedCustomerAccess()) return;
    this.setData({ canUploadOwnPhotos: canUploadOwnTechnicianPhotos() });
    void refreshOwnTechnicianPhotoAccess()
      .then((allowed) => this.setData({ canUploadOwnPhotos: allowed }))
      .catch(() => this.setData({ canUploadOwnPhotos: false }));
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
      const orderedTherapist = {
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
      };
      this.setData({
        therapist: orderedTherapist,
        selectedServiceSlug: selected?.slug ?? "",
        selectedServiceName: selected?.name ?? "",
        displayedServices: recommendedServices(
          orderedTherapist.services,
          selected?.slug ?? "",
        ),
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
  selectTab(event: { currentTarget: { dataset: { tab?: string } } }) {
    const activeTab = event.currentTarget.dataset.tab;
    if (!DETAIL_TABS.some((tab) => tab.key === activeTab)) return;
    const services = this.data.therapist?.services ?? [];
    this.setData({
      activeTab: activeTab as DetailTab,
      displayedServices:
        activeTab === "all"
          ? services
          : activeTab === "recommended"
            ? recommendedServices(services, this.data.selectedServiceSlug)
            : [],
    });
  },
  showAllProjects() {
    this.setData({
      activeTab: "all" as DetailTab,
      displayedServices: this.data.therapist?.services ?? [],
    });
  },
  openService(event: { currentTarget: { dataset: { slug?: string } } }) {
    const therapist = this.data.therapist;
    const slug = event.currentTarget.dataset.slug;
    if (!therapist || !slug || !requireVerifiedCustomerAccess()) return;
    if (!therapist.services.some((service) => service.slug === slug)) return;
    wx.navigateTo({
      url: `/pages/service-detail/index?slug=${encodeURIComponent(slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
    });
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

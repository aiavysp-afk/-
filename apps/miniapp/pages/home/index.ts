import type { PublicConfig, ServiceItem } from "@zydj/contracts";
import { api, money } from "../../utils/api";
import {
  hasVerifiedCustomerSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
import { getGcj02Location, reverseGeocode } from "../../utils/amap";
import { customerCenterPath } from "../../utils/customer-center";
import { type PublicTherapistView } from "../../utils/therapists";
import {
  loadPublicServiceDiscovery,
  serviceBookingState,
  serviceBookingLabel,
  serviceBookingAction,
  type ServiceBookingState,
} from "../../utils/service-discovery";

type HomeService = ServiceItem & {
  duration: string;
  price: string;
  tone: "sage" | "tea" | "clay";
  categoryLabel: string;
  therapistId: string;
  bookableCount: number;
  bookingState: ServiceBookingState;
  bookingLabel: string;
  bookingAction: string;
  artwork: string;
};

type HomeTherapist = PublicTherapistView & { express: boolean };
type Category = "POPULAR" | "RELAX" | "CARE";

const recommendedNames = [
  "法式SPA",
  "泰式SPA",
  "通络培元",
  "中式推拿",
  "非遗采耳",
];

const normalizeName = (name: string) => name.replace(/\s/g, "").toUpperCase();
const recommendedRank = (name: string) => {
  const index = recommendedNames.indexOf(normalizeName(name));
  return index < 0 ? recommendedNames.length : index;
};

const categoryLabels: Record<ServiceItem["category"], string> = {
  MASSAGE: "按摩舒缓",
  SPA_RELAXATION: "SPA 放松",
  FOOT_CARE: "足部养护",
};

Page({
  discoveryRequest: null as Promise<void> | null,
  data: {
    allServices: [] as HomeService[],
    services: [] as HomeService[],
    allTherapists: [] as HomeTherapist[],
    therapists: [] as HomeTherapist[],
    therapistLoading: false,
    therapistError: "",
    profileCount: 0,
    failedServiceIds: [] as string[],
    scheduleError: "",
    activeCategory: "POPULAR" as Category,
    categories: [
      { key: "POPULAR", label: "热门推荐", description: "人气放松项目" },
      { key: "RELAX", label: "调理", description: "日常舒缓养护" },
      { key: "CARE", label: "保健", description: "轻享品质放松" },
    ],
    newcomerBusy: false,
    newcomerError: "",
    newcomerClaimed: false,
    newcomerAvailable: true,
    newcomerReason: "登录后领取新人优惠券",
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
    await Promise.all([
      this.loadServices(),
      this.prepareLocation(),
      this.loadNewcomer(),
    ]);
  },
  async loadServices() {
    if (this.discoveryRequest) return this.discoveryRequest;
    this.setData({
      loading: true,
      error: "",
      therapistLoading: true,
      therapistError: "",
      scheduleError: "",
      allTherapists: [],
      therapists: [],
      allServices: this.data.allServices.map((service) => ({
        ...service,
        therapistId: "",
        bookableCount: 0,
        bookingState: "LOADING" as const,
        bookingLabel: serviceBookingLabel("LOADING"),
        bookingAction: serviceBookingAction("LOADING"),
      })),
    });
    this.applyCategory();
    const request = (async () => {
      try {
        const snapshot = await loadPublicServiceDiscovery();
        this.setData({
          profileCount: snapshot.profileCount,
          failedServiceIds: snapshot.failedServiceIds,
          scheduleError: snapshot.failedServiceIds.length
            ? "部分项目的排班读取失败，可重试；其他项目仍可按真实时段预约。"
            : "",
          allTherapists: snapshot.therapists
            .filter(
              (therapist) => therapist.publishedProfile && therapist.bookable,
            )
            .map((therapist) => ({
              ...therapist,
              express: therapist.tags.includes("极速达"),
            })),
          allServices: snapshot.services
            .slice()
            .sort(
              (left, right) =>
                recommendedRank(left.name) - recommendedRank(right.name),
            )
            .map((service, index) => ({
              ...service,
              duration: `${service.durationMinutes} 分钟`,
              price: money(service.priceFen),
              categoryLabel: categoryLabels[service.category],
              tone: (["sage", "tea", "clay"] as const)[index % 3]!,
              therapistId: "",
              bookableCount: 0,
              bookingState: "LOADING" as const,
              bookingLabel: serviceBookingLabel("LOADING"),
              bookingAction: serviceBookingAction("LOADING"),
              artwork:
                service.category === "FOOT_CARE" ||
                normalizeName(service.name).includes("采耳")
                  ? "care"
                  : "spa",
            })),
        });
        this.setData({
          therapists: this.data.allTherapists.slice(0, 8),
          loading: false,
        });
        this.applyCategory();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "服务与技师信息加载失败";
        this.setData({
          error: message,
          therapistError: message,
          therapists: [],
          allTherapists: [],
          allServices: this.data.allServices.map((service) => ({
            ...service,
            therapistId: "",
            bookableCount: 0,
            bookingState: "ERROR" as const,
            bookingLabel: serviceBookingLabel("ERROR"),
            bookingAction: serviceBookingAction("ERROR"),
          })),
        });
        this.applyCategory();
      } finally {
        this.setData({ loading: false, therapistLoading: false });
        this.applyCategory();
      }
    })();
    this.discoveryRequest = request;
    try {
      await request;
    } finally {
      this.discoveryRequest = null;
    }
  },
  async loadTherapists() {
    return this.loadServices();
  },
  selectCategory(event: { currentTarget: { dataset: { key: Category } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    this.setData({ activeCategory: event.currentTarget.dataset.key });
    this.applyCategory();
  },
  applyCategory() {
    const allServices = this.data.allServices.map((service) => {
      const availability = this.data.loading
        ? {
            bookingState: "LOADING" as const,
            therapistId: "",
            bookableCount: 0,
          }
        : this.data.error
          ? {
              bookingState: "ERROR" as const,
              therapistId: "",
              bookableCount: 0,
            }
          : serviceBookingState(service.id, {
              therapists: this.data.allTherapists,
              profileCount: this.data.profileCount,
              failedServiceIds: this.data.failedServiceIds,
            });
      return {
        ...service,
        ...availability,
        bookingLabel: serviceBookingLabel(availability.bookingState),
        bookingAction: serviceBookingAction(availability.bookingState),
      };
    });
    this.setData({
      allServices,
      services: allServices.filter((service) => {
        if (this.data.activeCategory === "RELAX")
          return service.category === "MASSAGE";
        if (this.data.activeCategory === "CARE")
          return service.category !== "MASSAGE";
        return true;
      }),
    });
  },
  async loadNewcomer() {
    if (!hasVerifiedCustomerSession()) {
      this.setData({
        newcomerClaimed: false,
        newcomerAvailable: true,
        newcomerReason: "登录后领取新人优惠券",
        newcomerError: "",
      });
      return;
    }
    try {
      const entitlement = await api<{
        claimed: boolean;
        eligible: boolean;
        reason: string;
      }>(customerCenterPath("/customer-center/newcomer-coupons"));
      this.setData({
        newcomerClaimed: entitlement.claimed,
        newcomerAvailable: entitlement.eligible,
        newcomerReason: entitlement.reason,
        newcomerError: "",
      });
    } catch (error) {
      this.setData({
        newcomerAvailable: false,
        newcomerError:
          error instanceof Error ? error.message : "新人优惠券读取失败",
      });
    }
  },
  async claimNewcomer() {
    if (!requireVerifiedCustomerAccess() || this.data.newcomerBusy) return;
    if (this.data.newcomerClaimed) {
      this.openNewcomer();
      return;
    }
    this.setData({ newcomerBusy: true, newcomerError: "" });
    try {
      const entitlement = await api<{
        claimed: boolean;
        eligible: boolean;
        reason: string;
      }>(customerCenterPath("/customer-center/newcomer-coupons"), "POST", {});
      this.setData({
        newcomerClaimed: entitlement.claimed,
        newcomerAvailable: entitlement.eligible,
        newcomerReason: entitlement.reason,
      });
      if (entitlement.claimed)
        wx.showToast({ title: "新人优惠券已领取", icon: "success" });
      else
        wx.showToast({
          title: entitlement.reason || "暂不可领取",
          icon: "none",
        });
    } catch (error) {
      this.setData({
        newcomerError:
          error instanceof Error ? error.message : "领取失败，请重试",
      });
    } finally {
      this.setData({ newcomerBusy: false });
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
    if (!requireVerifiedCustomerAccess()) return;
    if (this.data.locationError) {
      void this.locateCity();
      return;
    }
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
  openTherapist(event: { currentTarget: { dataset: { id?: string } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    const id = event.currentTarget.dataset.id;
    if (
      !id ||
      !this.data.therapists.some(
        (therapist) => therapist.id === id && therapist.bookable,
      )
    )
      return;
    wx.navigateTo({
      url: `/pages/therapist-detail/index?id=${encodeURIComponent(id)}`,
    });
  },
  bookService(e: { currentTarget: { dataset: { slug?: string } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    const slug = e.currentTarget.dataset.slug;
    const service = this.data.allServices.find((item) => item.slug === slug);
    if (!service) return;
    if (service.bookingState === "ERROR") {
      void this.loadServices();
      return;
    }
    if (this.data.loading || service.bookingState === "LOADING") {
      wx.showToast({ title: "正在更新可约状态，请稍候", icon: "none" });
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
  openServiceDetail(e: { currentTarget: { dataset: { slug?: string } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    const service = this.data.allServices.find((item) => item.slug === e.currentTarget.dataset.slug);
    if (!service) return;
    wx.navigateTo({ url: `/pages/service-detail/index?slug=${encodeURIComponent(service.slug)}` });
  },
});

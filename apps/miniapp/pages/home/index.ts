import type {
  PublicConfig,
  ServiceItem,
  TechnicianProfile,
} from "@zydj/contracts";
import { api, money } from "../../utils/api";
import {
  hasVerifiedCustomerSession,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
import { getGcj02Location, reverseGeocode } from "../../utils/amap";
import { customerCenterPath } from "../../utils/customer-center";
import {
  loadPublicTherapists,
  type PublicTherapistView,
} from "../../utils/therapists";

type HomeService = ServiceItem & {
  duration: string;
  price: string;
  tone: "sage" | "tea" | "clay";
  categoryLabel: string;
  therapistId: string;
  bookableCount: number;
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
  data: {
    allServices: [] as HomeService[],
    services: [] as HomeService[],
    allTherapists: [] as HomeTherapist[],
    therapists: [] as HomeTherapist[],
    therapistLoading: false,
    therapistError: "",
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
      this.loadTherapists(),
      this.prepareLocation(),
      this.loadNewcomer(),
    ]);
  },
  async loadServices() {
    this.setData({ loading: true, error: "" });
    try {
      const services = await api<ServiceItem[]>("/catalog/services");
      this.setData({
        allServices: services
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
            artwork:
              service.category === "FOOT_CARE" ||
              normalizeName(service.name).includes("采耳")
                ? "care"
                : "spa",
          })),
      });
      this.applyCategory();
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "服务目录加载失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  async loadTherapists() {
    this.setData({ therapistLoading: true, therapistError: "" });
    try {
      const [therapists, profiles] = await Promise.all([
        loadPublicTherapists(),
        api<TechnicianProfile[]>("/technicians"),
      ]);
      const profileOrder = new Map(
        profiles.map((profile, index) => [profile.technicianId, index]),
      );
      const bookableTherapists = therapists
        .filter((therapist) => therapist.publishedProfile && therapist.bookable)
        .sort(
          (left, right) =>
            (profileOrder.get(left.id) ?? profiles.length) -
            (profileOrder.get(right.id) ?? profiles.length),
        )
        .map((therapist) => ({
          ...therapist,
          // An express badge is displayed only if the reviewed profile says so.
          express: therapist.tags.includes("极速达"),
        }));
      this.setData({
        allTherapists: bookableTherapists,
        therapists: bookableTherapists.slice(0, 8),
      });
      this.applyCategory();
    } catch (error) {
      this.setData({
        therapists: [],
        allTherapists: [],
        therapistError:
          error instanceof Error ? error.message : "技师信息读取失败",
      });
      this.applyCategory();
    } finally {
      this.setData({ therapistLoading: false });
    }
  },
  selectCategory(event: { currentTarget: { dataset: { key: Category } } }) {
    if (!requireVerifiedCustomerAccess()) return;
    this.setData({ activeCategory: event.currentTarget.dataset.key });
    this.applyCategory();
  },
  applyCategory() {
    const allServices = this.data.allServices.map((service) => {
      const matches = this.data.allTherapists.filter((therapist) =>
        therapist.services.some(
          (item) => item.id === service.id && item.slots.length > 0,
        ),
      );
      return {
        ...service,
        therapistId: matches[0]?.id ?? "",
        bookableCount: matches.length,
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
    void Promise.all([this.loadServices(), this.loadTherapists()]);
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
    if (!service.therapistId) {
      wx.showToast({ title: "该项目暂无可预约技师", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/therapist-detail/index?id=${encodeURIComponent(service.therapistId)}&slug=${encodeURIComponent(service.slug)}`,
    });
  },
});

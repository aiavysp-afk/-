import type {
  AvailabilitySlot,
  BookingHold,
  OrderQuote,
  OrderView,
  AddressSuggestion,
  AddressVerification,
  PublicConfig,
  ServiceItem,
} from "@zydj/contracts";
import { api, money, newKey, shanghaiTime } from "../../utils/api";
import {
  getStoredSession,
  goToPhoneVerification,
  loginWithWechat,
  needsPhoneVerification,
} from "../../utils/auth";
import {
  getGcj02Location,
  reverseGeocode,
  suggestAddress,
} from "../../utils/amap";
Page({
  data: {
    service: null as ServiceItem | null,
    price: "",
    date: "",
    slots: [] as (AvailabilitySlot & { label: string; key: string })[],
    selected: -1,
    contactName: "",
    phone: "",
    detail: "",
    latitude: null as number | null,
    longitude: null as number | null,
    coordinateSystem: "GCJ-02" as const,
    amapMiniappKey: "",
    locationBusy: false,
    addressSuggestionAvailable: false,
    addressVerificationRequired: false,
    addressVerificationId: "",
    orderSubmissionAttempted: false,
    serviceCity: "",
    suggestions: [] as AddressSuggestion[],
    suggestionBusy: false,
    busy: false,
    error: "",
    consent: false,
    reservationId: "",
    orderKey: "",
    quote: "",
    loggedIn: false,
    phoneVerified: false,
    loginBusy: false,
    loginError: "",
    preferredTherapistId: "",
  },
  async onLoad(options: { slug?: string; therapistId?: string }) {
    const session = getStoredSession();
    this.setData({
      loggedIn: Boolean(session),
      phoneVerified: session?.user.phoneVerified === true,
      preferredTherapistId: options.therapistId ?? "",
    });
    void this.loadMapConfig();
    try {
      if (!options.slug) throw new Error("缺少服务参数");
      const service = await api<ServiceItem>(
        `/catalog/services/${encodeURIComponent(options.slug)}`,
      );
      this.setData({
        service,
        price: money(service.priceFen),
        date: new Date(Date.now() + 8 * 3600_000 + 86400_000)
          .toISOString()
          .slice(0, 10),
      });
      await this.loadSlots();
    } catch (error) {
      this.fail(error);
    }
  },
  onShow() {
    const session = getStoredSession();
    this.setData({
      loggedIn: Boolean(session),
      phoneVerified: session?.user.phoneVerified === true,
    });
  },
  async login() {
    if (this.data.loginBusy || this.data.loggedIn) return;
    this.setData({ loginBusy: true, loginError: "" });
    try {
      const session = await loginWithWechat();
      this.setData({
        loggedIn: true,
        phoneVerified: session.user.phoneVerified === true,
      });
      wx.showToast({ title: "登录成功", icon: "success" });
      if (needsPhoneVerification(session)) goToPhoneVerification();
    } catch (error) {
      this.setData({
        loginError: error instanceof Error ? error.message : "微信登录失败",
      });
    } finally {
      this.setData({ loginBusy: false });
    }
  },
  async loadMapConfig() {
    try {
      const config = await api<PublicConfig>("/config/public");
      this.setData({
        addressSuggestionAvailable: config.features.addressSuggestionAvailable,
        addressVerificationRequired:
          config.features.addressVerificationRequired,
        serviceCity: config.serviceCity,
        amapMiniappKey: config.map.miniappKey,
      });
    } catch {
      // Address search is an optional enhancement; manual entry remains usable.
      this.setData({ addressSuggestionAvailable: false });
    }
  },
  fail(error: unknown) {
    this.setData({
      error: error instanceof Error ? error.message : "请求失败",
    });
  },
  async loadSlots() {
    if (!this.data.service) return;
    this.setData({ error: "", selected: -1 });
    try {
      const slots = await api<AvailabilitySlot[]>(
        `/availability/slots?serviceId=${encodeURIComponent(this.data.service.id)}&date=${this.data.date}`,
      );
      const slotViews = slots.map((slot) => ({
        ...slot,
        label: shanghaiTime(slot.startsAt),
        key: `${slot.therapistId}-${slot.startsAt}`,
      }));
      const preferredIndex = this.data.preferredTherapistId
        ? slotViews.findIndex(
            (slot) => slot.therapistId === this.data.preferredTherapistId,
          )
        : -1;
      this.setData({
        slots: slotViews,
        selected: preferredIndex,
      });
    } catch (error) {
      this.fail(error);
    }
  },
  async dateChanged(e: { detail: { value: string } }) {
    if (this.data.reservationId) return;
    this.setData({ date: e.detail.value });
    await this.loadSlots();
  },
  select(e: { currentTarget: { dataset: { index: number } } }) {
    if (!this.data.reservationId)
      this.setData({ selected: Number(e.currentTarget.dataset.index) });
  },
  input(e: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    const field = e.currentTarget.dataset.field;
    if (
      ["contactName", "phone", "detail"].includes(field) &&
      !this.data.orderSubmissionAttempted
    )
      this.setData({
        [field]: e.detail.value,
        ...(field === "detail"
          ? {
              suggestions: [],
              addressVerificationId: "",
              latitude: null,
              longitude: null,
            }
          : {}),
      });
  },
  async locateAddress() {
    if (this.data.locationBusy || this.data.orderSubmissionAttempted) return;
    this.setData({ locationBusy: true, error: "", suggestions: [] });
    try {
      const point = await getGcj02Location();
      const address = await reverseGeocode(this.data.amapMiniappKey, point);
      this.setData({
        detail: address.detail,
        latitude: point.latitude,
        longitude: point.longitude,
        coordinateSystem: "GCJ-02",
        addressVerificationId: "",
      });
      wx.showToast({ title: "已定位并转为中文地址", icon: "success" });
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ locationBusy: false });
    }
  },
  async searchAddress() {
    if (
      this.data.suggestionBusy ||
      !this.data.addressSuggestionAvailable ||
      this.data.orderSubmissionAttempted
    )
      return;
    const keyword = this.data.detail.trim();
    if (keyword.length < 2 || keyword.length > 32) {
      this.fail(new Error("请输入 2 至 32 个字的地址关键词"));
      return;
    }
    this.setData({ suggestionBusy: true, error: "", suggestions: [] });
    try {
      const suggestions = await suggestAddress(
        this.data.amapMiniappKey,
        keyword,
        this.data.serviceCity,
      );
      this.setData({ suggestions });
      if (!suggestions.length)
        this.fail(new Error("当前服务城市内未找到匹配地址，请继续手填"));
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ suggestionBusy: false });
    }
  },
  selectAddress(e: { currentTarget: { dataset: { index: number } } }) {
    if (this.data.orderSubmissionAttempted) return;
    const suggestion =
      this.data.suggestions[Number(e.currentTarget.dataset.index)];
    if (!suggestion) return;
    const detail = `${suggestion.title} ${suggestion.address}`
      .trim()
      .slice(0, 200);
    this.setData({
      detail,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
      coordinateSystem: "GCJ-02",
      suggestions: [],
      addressVerificationId: "",
    });
  },
  consentChanged(e: { detail: { value: string[] } }) {
    this.setData({ consent: e.detail.value.includes("agree") });
  },
  async create() {
    if (this.data.busy) return;
    const slot = this.data.slots[this.data.selected],
      service = this.data.service;
    if (
      !service ||
      !slot ||
      !this.data.consent ||
      this.data.contactName.trim().length < 2 ||
      !/^1\d{10}$/.test(this.data.phone) ||
      this.data.detail.trim().length < 5
    ) {
      this.fail(
        new Error("请选择时段，填写有效地址与手机号码，并确认服务边界"),
      );
      return;
    }
    if (this.data.latitude === null || this.data.longitude === null) {
      this.fail(new Error("请先使用定位或高德地址搜索选择上门坐标"));
      return;
    }
    this.setData({ busy: true, error: "" });
    try {
      let session = getStoredSession();
      if (!session) {
        session = await loginWithWechat();
        this.setData({
          loggedIn: true,
          phoneVerified: session.user.phoneVerified === true,
          loginError: "",
        });
      }
      if (needsPhoneVerification(session)) {
        goToPhoneVerification();
        return;
      }
      if (!this.data.reservationId) {
        const hold = await api<BookingHold>("/booking-holds", "POST", {
          serviceId: service.id,
          therapistId: slot.therapistId,
          startsAt: slot.startsAt,
        });
        this.setData({ reservationId: hold.id, orderKey: newKey() });
      }
      if (
        this.data.addressVerificationRequired &&
        !this.data.addressVerificationId
      ) {
        const verification = await api<AddressVerification>(
          "/locations/address-verifications",
          "POST",
          {
            reservationId: this.data.reservationId,
            detail: this.data.detail.trim(),
            latitude: this.data.latitude,
            longitude: this.data.longitude,
            coordinateSystem: "GCJ-02",
          },
        );
        this.setData({ addressVerificationId: verification.id });
      }
      if (!this.data.quote) {
        const quote = await api<OrderQuote>("/orders/quote", "POST", {
          reservationId: this.data.reservationId,
        });
        this.setData({ quote: money(quote.payableFen) });
      }
      // Once an order request leaves the device, keep the request immutable so
      // an uncertain network result can be retried with the same fingerprint.
      this.setData({ orderSubmissionAttempted: true });
      await api<OrderView>(
        "/orders",
        "POST",
        {
          reservationId: this.data.reservationId,
          address: {
            contactName: this.data.contactName.trim(),
            phone: this.data.phone,
            detail: this.data.detail.trim(),
            latitude: this.data.latitude,
            longitude: this.data.longitude,
            coordinateSystem: "GCJ-02",
          },
          ...(this.data.addressVerificationId
            ? { addressVerificationId: this.data.addressVerificationId }
            : {}),
        },
        this.data.orderKey,
      );
      this.setData({
        reservationId: "",
        orderKey: "",
        addressVerificationId: "",
        orderSubmissionAttempted: false,
      });
      wx.showToast({ title: "订单已创建，请到订单页支付", icon: "none" });
      wx.switchTab({ url: "/pages/orders/index" });
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  onUnload() {
    this.setData({
      contactName: "",
      phone: "",
      detail: "",
      latitude: null,
      longitude: null,
      suggestions: [],
      addressVerificationId: "",
      orderSubmissionAttempted: false,
    });
  },
});

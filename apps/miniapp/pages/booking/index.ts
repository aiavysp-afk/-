import type {
  AvailabilitySlot,
  BookingHold,
  CustomerAddress,
  CustomerCoupon,
  OrderQuote,
  OrderView,
  PaymentIntent,
  FriendPaymentShare,
  AddressSuggestion,
  AddressVerification,
  GeocodedAddress,
  PublicConfig,
  ServiceItem,
  TechnicianReview,
} from "@zydj/contracts";
import { ApiError, api, money, newKey, shanghaiTime } from "../../utils/api";
import {
  getStoredSession,
  goToPhoneVerification,
  loginWithWechat,
  needsPhoneVerification,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import {
  getGcj02Location,
  reverseGeocode,
  suggestAddress,
} from "../../utils/amap";
import {
  AppointmentMode,
  assertServerQuote,
  bookingCouponRows,
  pickSlotIndex,
  quoteDisplay,
  shanghaiDate,
} from "../../utils/booking";
import { customerCenterPath } from "../../utils/customer-center";
import { assertFriendPaymentShare } from "../../utils/friend-payment";

type QuoteDisplay = ReturnType<typeof quoteDisplay>;
type ReviewView = TechnicianReview & {
  stars: string;
  dateLabel: string;
};
type BookingSlotView = AvailabilitySlot & {
  label: string;
  key: string;
  hourKey: string;
  sourceIndex: number;
};

const categoryNames: Record<ServiceItem["category"], string> = {
  MASSAGE: "按摩舒缓",
  SPA_RELAXATION: "SPA 放松",
  FOOT_CARE: "足部养护",
};

function definitiveOrderRejection(error: unknown): "coupon" | "hold" | "address" | null {
  if (!(error instanceof ApiError) || error.path !== "/orders" || error.method !== "POST") return null;
  // These exact create errors occur after a rollback/no-order result and the
  // server's idempotency/reservation-order recheck. Never unlock for an existing
  // order conflict, arbitrary 4xx, transport failure or 5xx.
  const rejection = `${error.statusCode}:${error.message}`;
  switch (rejection) {
    case "409:优惠券已失效、已被使用或未达到项目费门槛，请重新获取报价":
    case "409:优惠券状态已变化，请重新获取报价":
      return "coupon";
    case "409:预约占位已过期":
    case "409:预约占位状态已变化":
      return "hold";
    case "422:请先完成服务地址核验":
    case "422:服务地址核验已失效，请重新核验":
      return "address";
    default:
      return null;
  }
}

Page({
  quoteRevision: 0,
  slotsRevision: 0,
  quoteRefreshQueued: false,
  quoteTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  pageClosed: false,
  data: {
    service: null as ServiceItem | null,
    price: "",
    categoryName: "",
    quantity: 1,
    appointmentMode: "soon" as AppointmentMode,
    date: "",
    minDate: "",
    maxDate: "",
    slots: [] as BookingSlotView[],
    visibleSlots: [] as BookingSlotView[],
    hourOptions: [] as string[],
    activeHour: "",
    selected: -1,
    selectedSlotLabel: "",
    contactName: "",
    phone: "",
    detail: "",
    doorNumber: "",
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
    quoteDetails: null as QuoteDisplay | null,
    quoteCouponId: undefined as string | null | undefined,
    quoteLoading: false,
    quoteError: "",
    quoteFingerprint: "",
    reservationSlotKey: "",
    reservationExpiresAt: "",
    couponChoice: "auto",
    coupons: [] as ReturnType<typeof bookingCouponRows>,
    couponsLoading: false,
    couponsError: "",
    couponPickerOpen: false,
    couponSummary: "自动选择最高可用优惠",
    loggedIn: false,
    phoneVerified: false,
    loginBusy: false,
    loginError: "",
    preferredTherapistId: "",
    savedAddresses: [] as CustomerAddress[],
    selectedAddressId: "",
    addressBookLoading: false,
    addressBookLoaded: false,
    addressBookError: "",
    serviceReviews: [] as ReviewView[],
    reviewsLoading: false,
    reviewsError: "",
    paymentMode: "WECHAT" as "WECHAT" | "FRIEND",
  },
  async onLoad(options: { slug?: string; therapistId?: string }) {
    this.pageClosed = false;
    if (!requireVerifiedCustomerAccess()) return;
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
        categoryName: categoryNames[service.category],
        date: shanghaiDate(),
        minDate: shanghaiDate(),
        maxDate: shanghaiDate(30),
      });
      await Promise.all([
        this.loadSlots(),
        this.loadServiceReviews(service.slug),
        this.loadCoupons(),
      ]);
    } catch (error) {
      this.fail(error);
    }
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    const session = getStoredSession();
    this.setData({
      loggedIn: Boolean(session),
      phoneVerified: session?.user.phoneVerified === true,
    });
    await this.loadSavedAddresses();
    if (this.data.service) void this.loadCoupons();
    this.scheduleQuote();
  },
  async loadSavedAddresses() {
    if (this.data.addressBookLoading || this.data.orderSubmissionAttempted)
      return;
    this.setData({ addressBookLoading: true, addressBookError: "" });
    try {
      const savedAddresses = await api<CustomerAddress[]>(
        customerCenterPath("/customer-center/addresses"),
      );
      const selectedAddress = savedAddresses.find(
        (item) => item.id === this.data.selectedAddressId,
      );
      const hasDraft = Boolean(
        this.data.contactName.trim() ||
          this.data.phone.trim() ||
          this.data.detail.trim() ||
          this.data.doorNumber.trim(),
      );
      this.setData({
        savedAddresses,
        addressBookLoaded: true,
        ...(this.data.selectedAddressId && !selectedAddress
          ? { selectedAddressId: "" }
          : {}),
      });
      if (selectedAddress) {
        this.applySavedAddress(selectedAddress);
        return;
      }
      if (!hasDraft) {
        const preferred =
          savedAddresses.find((item) => item.isDefault) ?? savedAddresses[0];
        if (preferred) this.applySavedAddress(preferred);
      }
    } catch (error) {
      this.setData({
        addressBookLoaded: true,
        addressBookError:
          error instanceof Error
            ? `${error.message}，可继续手动填写`
            : "地址簿读取失败，可继续手动填写",
      });
    } finally {
      this.setData({ addressBookLoading: false });
    }
  },
  applySavedAddress(address: CustomerAddress) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    this.setData({
      selectedAddressId: address.id,
      contactName: address.contactName,
      phone: address.phone,
      detail: address.detail,
      doorNumber: "",
      latitude: address.latitude,
      longitude: address.longitude,
      coordinateSystem: "GCJ-02",
      suggestions: [],
      addressVerificationId: "",
      quoteDetails: null,
      error: "",
    });
    this.invalidateQuote();
  },
  chooseSavedAddress(event: { currentTarget: { dataset: { id: string } } }) {
    const address = this.data.savedAddresses.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (address) this.applySavedAddress(address);
  },
  openAddressManager() {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    wx.navigateTo({ url: "/pages/addresses/index" });
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
    const revision = ++this.slotsRevision;
    const serviceId = this.data.service.id;
    const date = this.data.date;
    this.invalidateQuote(false);
    this.setData({ error: "", selected: -1 });
    try {
      const slots = await api<AvailabilitySlot[]>(
        `/availability/slots?serviceId=${encodeURIComponent(serviceId)}&date=${date}`,
      );
      if (this.pageClosed || revision !== this.slotsRevision) return;
      const slotViews = slots.map((slot, sourceIndex) => {
        const label = shanghaiTime(slot.startsAt).slice(11);
        return {
          ...slot,
          label,
          key: `${slot.therapistId}-${slot.startsAt}`,
          hourKey: `${label.slice(0, 2)}:00`,
          sourceIndex,
        };
      });
      const selected = pickSlotIndex(
        slotViews,
        this.data.preferredTherapistId,
        this.data.appointmentMode,
      );
      const hourOptions = [...new Set(slotViews.map((slot) => slot.hourKey))];
      const activeHour = slotViews[selected]?.hourKey ?? hourOptions[0] ?? "";
      this.setData({
        slots: slotViews,
        visibleSlots: slotViews.filter((slot) => slot.hourKey === activeHour),
        hourOptions,
        activeHour,
        selected,
        selectedSlotLabel: slotViews[selected]?.label ?? "",
      });
      this.invalidateQuote();
    } catch (error) {
      if (!this.pageClosed && revision === this.slotsRevision) this.fail(error);
    }
  },
  async loadServiceReviews(slug: string) {
    this.setData({ reviewsLoading: true, reviewsError: "" });
    try {
      const reviews = await api<TechnicianReview[]>(
        `/catalog/services/${encodeURIComponent(slug)}/reviews`,
      );
      this.setData({
        serviceReviews: reviews.map((review) => ({
          ...review,
          stars: "★".repeat(review.rating),
          dateLabel: shanghaiTime(review.createdAt).slice(0, 10),
        })),
      });
    } catch (error) {
      this.setData({
        serviceReviews: [],
        reviewsError:
          error instanceof Error ? error.message : "用户评价读取失败",
      });
    } finally {
      this.setData({ reviewsLoading: false });
    }
  },
  async dateChanged(e: { detail: { value: string } }) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    this.setData({
      date: e.detail.value,
      selected: -1,
      selectedSlotLabel: "",
      visibleSlots: [],
      hourOptions: [],
      activeHour: "",
      quoteDetails: null,
    });
    await this.loadSlots();
  },
  async setAppointmentMode(e: {
    currentTarget: { dataset: { mode: AppointmentMode } };
  }) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    const appointmentMode = e.currentTarget.dataset.mode;
    if (appointmentMode === this.data.appointmentMode) return;
    this.setData({
      appointmentMode,
      date: appointmentMode === "soon" ? shanghaiDate() : shanghaiDate(1),
      selected: -1,
      selectedSlotLabel: "",
      visibleSlots: [],
      hourOptions: [],
      activeHour: "",
      quoteDetails: null,
      error: "",
    });
    await this.loadSlots();
  },
  quantityNotice() {
    wx.showToast({
      title: "当前每笔预约仅支持 1 项服务",
      icon: "none",
    });
  },
  select(e: { currentTarget: { dataset: { index: number } } }) {
    if (!this.data.busy && !this.data.orderSubmissionAttempted) {
      const selected = Number(e.currentTarget.dataset.index);
      this.setData({
        selected,
        selectedSlotLabel: this.data.slots[selected]?.label ?? "",
        quoteDetails: null,
        error: "",
      });
      this.invalidateQuote();
    }
  },
  selectHour(e: { currentTarget: { dataset: { hour: string } } }) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    const activeHour = e.currentTarget.dataset.hour;
    const visibleSlots = this.data.slots.filter(
      (slot) => slot.hourKey === activeHour,
    );
    const selected = visibleSlots[0]?.sourceIndex ?? -1;
    this.setData({
      activeHour,
      visibleSlots,
      selected,
      selectedSlotLabel: this.data.slots[selected]?.label ?? "",
      quoteDetails: null,
      error: "",
    });
    this.invalidateQuote();
  },
  input(e: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    const field = e.currentTarget.dataset.field;
    if (
      ["contactName", "phone", "detail", "doorNumber"].includes(field) &&
      !this.data.orderSubmissionAttempted && !this.data.busy
    ) {
      const addressFieldChanged = ["detail", "doorNumber"].includes(field);
      this.setData({
        [field]: e.detail.value,
        selectedAddressId: "",
        ...(addressFieldChanged
          ? {
              suggestions: [],
              addressVerificationId: "",
              quoteDetails: null,
              latitude: null,
              longitude: null,
            }
          : {}),
      });
      this.invalidateQuote();
    }
  },
  async locateAddress() {
    if (this.data.locationBusy || this.data.busy || this.data.orderSubmissionAttempted) return;
    this.setData({ locationBusy: true, error: "", suggestions: [] });
    const revision = this.quoteRevision;
    try {
      const point = await getGcj02Location();
      const address = await reverseGeocode(this.data.amapMiniappKey, point);
      if (this.pageClosed || revision !== this.quoteRevision || this.data.orderSubmissionAttempted) return;
      this.setData({
        selectedAddressId: "",
        detail: address.detail.slice(0, 140),
        latitude: point.latitude,
        longitude: point.longitude,
        coordinateSystem: "GCJ-02",
        addressVerificationId: "",
        quoteDetails: null,
      });
      this.invalidateQuote();
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
      || this.data.busy
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
      if (this.pageClosed || this.data.detail.trim() !== keyword || this.data.orderSubmissionAttempted) return;
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
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    const suggestion =
      this.data.suggestions[Number(e.currentTarget.dataset.index)];
    if (!suggestion) return;
    const detail = `${suggestion.title} ${suggestion.address}`
      .trim()
      .slice(0, 140);
    this.setData({
      selectedAddressId: "",
      detail,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
      coordinateSystem: "GCJ-02",
      suggestions: [],
      addressVerificationId: "",
      quoteDetails: null,
    });
    this.invalidateQuote();
  },
  consentChanged(e: { detail: { value: string[] } }) {
    this.setData({ consent: e.detail.value.includes("agree") });
  },
  draftFingerprint() {
    const slot = this.data.slots[this.data.selected];
    return JSON.stringify({
      serviceId: this.data.service?.id,
      therapistId: slot?.therapistId,
      startsAt: slot?.startsAt,
      quantity: this.data.quantity,
      couponChoice: this.data.couponChoice,
      contactName: this.data.contactName.trim(),
      phone: this.data.phone,
      address: this.fullAddress(),
      latitude: this.data.latitude,
      longitude: this.data.longitude,
    });
  },
  invalidateQuote(refresh = true) {
    if (this.data.orderSubmissionAttempted) return;
    ++this.quoteRevision;
    this.setData({ quoteDetails: null, quoteFingerprint: "", quoteError: "" });
    if (refresh) this.scheduleQuote();
  },
  scheduleQuote() {
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    if (this.pageClosed || this.data.busy || this.data.orderSubmissionAttempted) return;
    this.quoteTimer = setTimeout(() => {
      this.quoteTimer = undefined;
      void this.refreshQuote();
    }, 400);
  },
  async loadCoupons() {
    if (this.data.couponsLoading) return;
    this.setData({ couponsLoading: true, couponsError: "" });
    try {
      const coupons = await api<CustomerCoupon[]>(customerCenterPath("/customer-center/coupons"));
      if (this.pageClosed) return;
      this.setData({ coupons: bookingCouponRows(coupons, this.data.service?.priceFen ?? 0) });
    } catch (error) {
      if (!this.pageClosed) this.setData({
        couponsError: error instanceof Error ? error.message : "优惠券读取失败，请重试",
      });
    } finally {
      if (!this.pageClosed) this.setData({ couponsLoading: false });
    }
  },
  async openCoupons() {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    this.setData({ couponPickerOpen: true });
    await this.loadCoupons();
  },
  closeCoupons() {
    this.setData({ couponPickerOpen: false });
  },
  ignoreTap() {},
  chooseCoupon(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    const couponChoice = event.currentTarget.dataset.id;
    if (!["auto", "none"].includes(couponChoice)
      && !this.data.coupons.some((row) => row.id === couponChoice && row.eligible)) return;
    this.setData({ couponChoice, couponPickerOpen: false });
    this.invalidateQuote();
  },
  async refreshQuote(force = false) {
    if (this.pageClosed || this.data.orderSubmissionAttempted || (this.data.busy && !force)) return false;
    if (this.data.quoteLoading) {
      this.quoteRefreshQueued = true;
      return false;
    }
    const service = this.data.service;
    const slot = this.data.slots[this.data.selected];
    if (!service || !slot) return false;
    if (this.data.quantity !== 1) {
      this.setData({ quoteError: "当前预约系统每单仅支持 1 项服务" });
      return false;
    }
    const session = getStoredSession();
    if (!session || needsPhoneVerification(session)) return false;
    const revision = this.quoteRevision;
    const fingerprint = this.draftFingerprint();
    const slotKey = `${service.id}:${slot.therapistId}:${slot.startsAt}`;
    const couponChoice = this.data.couponChoice;
    this.setData({ quoteLoading: true, quoteError: "", quoteDetails: null });
    try {
      if (this.data.reservationId && (this.data.reservationSlotKey !== slotKey
        || Date.parse(this.data.reservationExpiresAt) <= Date.now())) {
        const oldId = this.data.reservationId;
        if (Date.parse(this.data.reservationExpiresAt) > Date.now()) {
          await api(`/booking-holds/${encodeURIComponent(oldId)}/release`, "POST", {});
        }
        this.setData({ reservationId: "", reservationSlotKey: "", reservationExpiresAt: "", addressVerificationId: "" });
      }
      if (!this.data.reservationId) {
        // A hold is real capacity, not an invented technician/time. Keep only
        // one active hold and release it before changing the chosen slot.
        const hold = await api<BookingHold>("/booking-holds", "POST", {
          serviceId: service.id, therapistId: slot.therapistId, startsAt: slot.startsAt,
        });
        this.setData({
          reservationId: hold.id, reservationSlotKey: slotKey,
          reservationExpiresAt: hold.expiresAt, orderKey: newKey(), addressVerificationId: "",
        });
        if (this.pageClosed) {
          await api(`/booking-holds/${encodeURIComponent(hold.id)}/release`, "POST", {});
          return false;
        }
      }
      const reservationId = this.data.reservationId;
      const quote = await api<OrderQuote>("/orders/quote", "POST", {
        reservationId,
        ...(couponChoice === "auto" ? {} : { couponId: couponChoice === "none" ? null : couponChoice }),
      });
      assertServerQuote(quote, reservationId);
      if (quote.travelFeeFen !== 0) throw new Error("当前报价异常，已阻止提交");
      if (this.pageClosed) {
        await api(`/booking-holds/${encodeURIComponent(reservationId)}/release`, "POST", {});
        return false;
      }
      if (revision !== this.quoteRevision || fingerprint !== this.draftFingerprint()) return false;
      const appliedCoupon = this.data.coupons.find((row) => row.id === quote.couponId);
      this.setData({
        quoteDetails: quoteDisplay(quote), quoteCouponId: quote.couponId ?? null,
        quoteFingerprint: fingerprint,
        coupons: bookingCouponRows(this.data.coupons, quote.serviceAmountFen),
        couponSummary: quote.discountFen > 0
          ? `${appliedCoupon?.title ?? "已使用优惠券"} · 减 ¥${money(quote.discountFen)}`
          : couponChoice === "none" ? "本单不使用优惠券" : "暂无符合项目费门槛的优惠券",
      });
      return true;
    } catch (error) {
      if (!this.pageClosed && revision === this.quoteRevision) this.setData({
        quoteDetails: null, quoteFingerprint: "",
        quoteError: error instanceof Error ? error.message : "实时价格读取失败，请重试",
      });
      return false;
    } finally {
      if (!this.pageClosed) {
        this.setData({ quoteLoading: false });
        if (this.quoteRefreshQueued || revision !== this.quoteRevision) {
          this.quoteRefreshQueued = false;
          this.scheduleQuote();
        }
      }
    }
  },
  fullAddress() {
    return `${this.data.detail.trim()} ${this.data.doorNumber.trim()}`.trim();
  },
  async ensureAddressCoordinates() {
    if (this.data.latitude !== null && this.data.longitude !== null)
      return {
        latitude: this.data.latitude,
        longitude: this.data.longitude,
        coordinateSystem: "GCJ-02" as const,
      };
    const geocoded = await api<GeocodedAddress>(
      "/locations/address-geocodes",
      "POST",
      { detail: this.data.detail.trim() },
    );
    this.setData({
      latitude: geocoded.latitude,
      longitude: geocoded.longitude,
      coordinateSystem: "GCJ-02",
      addressVerificationId: "",
      quoteDetails: null,
    });
    this.invalidateQuote(false);
    wx.showToast({ title: "手填地址已用高德识别", icon: "success" });
    return geocoded;
  },
  validDraft() {
    const slot = this.data.slots[this.data.selected];
    const service = this.data.service;
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
      return null;
    }
    return { service, slot };
  },
  async prepareOrder() {
    if (this.data.busy || this.data.quoteLoading || this.data.locationBusy || this.data.suggestionBusy) return;
    const draft = this.validDraft();
    if (!draft) return;
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
      const addressPoint = await this.ensureAddressCoordinates();
      if (!await this.refreshQuote(true)) {
        this.fail(new Error(this.data.quoteError || "服务器价格尚未确认，请稍后重试"));
        return;
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
            detail: this.fullAddress(),
            latitude: addressPoint.latitude,
            longitude: addressPoint.longitude,
            coordinateSystem: "GCJ-02",
          },
        );
        this.setData({ addressVerificationId: verification.id });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  async create() {
    if (this.data.busy || this.data.quoteLoading || this.data.locationBusy || this.data.suggestionBusy) return;
    const retryingUncertainSubmission = this.data.orderSubmissionAttempted;
    if (!this.data.quoteDetails) {
      await this.prepareOrder();
      return;
    }
    if (!this.data.orderSubmissionAttempted) {
      const shownPayable = this.data.quoteDetails.payable;
      const shownCoupon = this.data.quoteCouponId;
      await this.prepareOrder();
      if (this.data.error || !this.data.quoteDetails) return;
      if (this.data.quoteDetails.payable !== shownPayable || this.data.quoteCouponId !== shownCoupon) {
        wx.showToast({ title: "优惠或价格已更新，请核对后再提交", icon: "none" });
        return;
      }
      if (this.data.quoteFingerprint !== this.draftFingerprint()) return;
    }
    if (!this.validDraft() || !this.data.reservationId) return;
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
      // Once an order request leaves the device, keep the request immutable so
      // an uncertain network result can be retried with the same fingerprint.
      this.setData({ orderSubmissionAttempted: true });
      const order = await api<OrderView>(
        "/orders",
        "POST",
        {
          reservationId: this.data.reservationId,
          couponId: this.data.quoteCouponId,
          address: {
            contactName: this.data.contactName.trim(),
            phone: this.data.phone,
            detail: this.fullAddress(),
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
      if (this.pageClosed) return;
      if (order.travelFeeFen !== 0
        || !this.data.quoteDetails
        || money(order.serviceAmountFen) !== this.data.quoteDetails.serviceAmount
        || money(order.discountFen) !== this.data.quoteDetails.discount
        || money(order.payableFen) !== this.data.quoteDetails.payable) {
        wx.showModal({
          title: "订单价格异常",
          content:
            "该订单未通过金额复核，不会调起支付。请在订单页核对金额或联系客服处理。",
          showCancel: false,
        });
        wx.redirectTo({ url: "/pages/orders/index" });
        return;
      }
      this.setData({
        reservationId: "",
        orderKey: "",
        addressVerificationId: "",
        quoteDetails: null,
        reservationSlotKey: "",
        reservationExpiresAt: "",
        quoteFingerprint: "",
        orderSubmissionAttempted: false,
      });
      if (this.data.paymentMode === "FRIEND") {
        await this.shareCreatedOrder(order);
        return;
      }
      await this.payCreatedOrder(order);
      wx.redirectTo({ url: "/pages/orders/index" });
    } catch (error) {
      const rejection = definitiveOrderRejection(error);
      if (this.data.orderSubmissionAttempted && !retryingUncertainSubmission && rejection) {
        // A prior uncertain request may still be in flight. Only a first, known
        // rejected submission can safely return to an editable draft.
        this.setData({
          orderSubmissionAttempted: false,
          orderKey: newKey(),
          addressVerificationId: "",
          ...(rejection === "hold" ? {
            reservationId: "", reservationSlotKey: "", reservationExpiresAt: "",
          } : {}),
          ...(rejection === "address" ? { addressVerificationRequired: true } : {}),
        });
        this.invalidateQuote(false);
        void this.loadCoupons();
      }
      this.fail(error);
    } finally {
      this.setData({ busy: false });
    }
  },
  choosePaymentMode(event: { currentTarget: { dataset: { mode: string } } }) {
    if (this.data.busy || this.data.orderSubmissionAttempted) return;
    const mode = event.currentTarget.dataset.mode;
    if (mode === "WECHAT" || mode === "FRIEND") this.setData({ paymentMode: mode });
  },
  async shareCreatedOrder(order: OrderView) {
    if (order.status !== "PENDING_PAYMENT") {
      wx.redirectTo({ url: "/pages/orders/index" });
      return;
    }
    try {
      // Do not create the owner's prepay first. The server chooses and locks
      // exactly one real payer before creating a WeChat payment intent.
      const share = assertFriendPaymentShare(await api<FriendPaymentShare>(
        `/orders/${order.id}/friend-payment`, "POST", {},
      ), order.payableFen);
      wx.redirectTo({ url: share.miniappPath });
    } catch (error) {
      wx.showModal({
        title: "订单已保留",
        content: `${error instanceof Error ? error.message : "代付分享暂不可用"}。可在订单页继续操作，请勿重复下单。`,
        showCancel: false,
      });
      wx.redirectTo({ url: "/pages/orders/index" });
    }
  },
  async payCreatedOrder(order: OrderView) {
    if (order.status !== "PENDING_PAYMENT") return;
    let intent: PaymentIntent;
    try {
      intent = await api<PaymentIntent>(
        `/orders/${order.id}/payment-intent`,
        "POST",
        {},
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "微信支付暂时无法发起";
      wx.showModal({
        title: "订单已创建",
        content: `${message}。订单已安全保存，可在“订单”页继续支付。`,
        confirmText: "查看订单",
        showCancel: false,
      });
      return;
    }
    if (
      !intent ||
      typeof intent.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id) ||
      intent.orderId !== order.id ||
      !Number.isSafeInteger(intent.amountFen) ||
      intent.amountFen <= 0 ||
      intent.amountFen !== order.payableFen
    ) {
      wx.showModal({
        title: "订单已创建",
        content: "支付订单或金额核验失败。请在订单页刷新后重试，切勿重复下单。",
        confirmText: "查看订单",
        showCancel: false,
      });
      return;
    }
    if (intent.provider !== "WECHAT") {
      wx.showToast({ title: "订单已创建，请在订单页继续支付", icon: "none" });
      return;
    }
    if (
      intent.status !== "PENDING" ||
      intent.prepayState !== "READY" ||
      !intent.wechatPayParameters
    ) {
      try {
        const result = await api<{ status: string }>(
          `/payments/${intent.id}/reconcile`,
          "POST",
          {},
        );
        if (result.status === "SUCCEEDED") {
          wx.showToast({ title: "支付已确认", icon: "success" });
          return;
        }
      } catch {
        /* The order page remains the only safe retry surface. */
      }
      wx.showModal({
        title: "订单已创建",
        content:
          "微信预下单结果待确认。请在订单页刷新或查询原单，切勿重复下单。",
        confirmText: "查看订单",
        showCancel: false,
      });
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: "确认微信支付",
        content: `本次预约应付 ¥${money(intent.amountFen)}，确认后将打开微信支付。最终结果以微信支付通知和原单查询为准。`,
        confirmText: "去支付",
        success: (result) => resolve(result.confirm === true),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) {
      wx.showToast({ title: "订单已保留，可稍后继续支付", icon: "none" });
      return;
    }
    const sdkResult = await new Promise<"success" | "cancel" | "failure">(
      (resolve) =>
        wx.requestPayment({
          ...intent.wechatPayParameters!,
          success: () => resolve("success"),
          fail: (error) =>
            resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
        }),
    );
    try {
      const result = await api<{ status: string }>(
        `/payments/${intent.id}/reconcile`,
        "POST",
        {},
      );
      if (result.status === "SUCCEEDED") {
        wx.showToast({ title: "支付成功，预约已生效", icon: "success" });
        return;
      }
    } catch {
      /* Notification/query may arrive after the native SDK returns. */
    }
    if (sdkResult === "cancel") {
      wx.showToast({ title: "已取消支付，订单仍为待付款", icon: "none" });
      return;
    }
    wx.showToast({ title: "支付结果确认中，请在订单页刷新", icon: "none" });
  },
  onUnload() {
    this.pageClosed = true;
    ++this.quoteRevision;
    ++this.slotsRevision;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    if (this.data.reservationId && !this.data.orderSubmissionAttempted && !this.data.quoteLoading) {
      void api(`/booking-holds/${encodeURIComponent(this.data.reservationId)}/release`, "POST", {}).catch(() => undefined);
    }
    this.setData({
      contactName: "",
      phone: "",
      detail: "",
      doorNumber: "",
      latitude: null,
      longitude: null,
      suggestions: [],
      savedAddresses: [],
      selectedAddressId: "",
      addressBookLoaded: false,
      addressBookError: "",
      addressVerificationId: "",
      quoteDetails: null,
      orderSubmissionAttempted: false,
    });
  },
});

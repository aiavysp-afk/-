"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
const amap_1 = require("../../utils/amap");
const customer_center_1 = require("../../utils/customer-center");
const service_discovery_1 = require("../../utils/service-discovery");
const recommendedNames = [
    "法式SPA",
    "泰式SPA",
    "通络培元",
    "中式推拿",
    "非遗采耳",
];
const normalizeName = (name) => name.replace(/\s/g, "").toUpperCase();
const recommendedRank = (name) => {
    const index = recommendedNames.indexOf(normalizeName(name));
    return index < 0 ? recommendedNames.length : index;
};
const categoryLabels = {
    MASSAGE: "按摩舒缓",
    SPA_RELAXATION: "SPA 放松",
    FOOT_CARE: "足部养护",
};
Page({
    discoveryRequest: null,
    data: {
        allServices: [],
        services: [],
        allTherapists: [],
        therapists: [],
        therapistLoading: false,
        therapistError: "",
        profileCount: 0,
        failedServiceIds: [],
        scheduleError: "",
        activeCategory: "POPULAR",
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
        this.setData({ accessReady: (0, auth_1.hasVerifiedCustomerSession)() });
        (0, tab_bar_1.syncCustomTabBar)(this, 0);
        await Promise.all([
            this.loadServices(),
            this.prepareLocation(),
            this.loadNewcomer(),
        ]);
    },
    async loadServices() {
        if (this.discoveryRequest)
            return this.discoveryRequest;
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
                bookingState: "LOADING",
                bookingLabel: (0, service_discovery_1.serviceBookingLabel)("LOADING"),
                bookingAction: (0, service_discovery_1.serviceBookingAction)("LOADING"),
            })),
        });
        this.applyCategory();
        const request = (async () => {
            try {
                const snapshot = await (0, service_discovery_1.loadPublicServiceDiscovery)();
                this.setData({
                    profileCount: snapshot.profileCount,
                    failedServiceIds: snapshot.failedServiceIds,
                    scheduleError: snapshot.failedServiceIds.length
                        ? "部分项目的排班读取失败，可重试；其他项目仍可按真实时段预约。"
                        : "",
                    allTherapists: snapshot.therapists
                        .filter((therapist) => therapist.publishedProfile && therapist.bookable)
                        .map((therapist) => ({
                        ...therapist,
                        express: therapist.tags.includes("极速达"),
                    })),
                    allServices: snapshot.services
                        .slice()
                        .sort((left, right) => recommendedRank(left.name) - recommendedRank(right.name))
                        .map((service, index) => ({
                        ...service,
                        duration: `${service.durationMinutes} 分钟`,
                        price: (0, api_1.money)(service.priceFen),
                        categoryLabel: categoryLabels[service.category],
                        tone: ["sage", "tea", "clay"][index % 3],
                        therapistId: "",
                        bookableCount: 0,
                        bookingState: "LOADING",
                        bookingLabel: (0, service_discovery_1.serviceBookingLabel)("LOADING"),
                        bookingAction: (0, service_discovery_1.serviceBookingAction)("LOADING"),
                        artwork: service.category === "FOOT_CARE" ||
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
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "服务与技师信息加载失败";
                this.setData({
                    error: message,
                    therapistError: message,
                    therapists: [],
                    allTherapists: [],
                    allServices: this.data.allServices.map((service) => ({
                        ...service,
                        therapistId: "",
                        bookableCount: 0,
                        bookingState: "ERROR",
                        bookingLabel: (0, service_discovery_1.serviceBookingLabel)("ERROR"),
                        bookingAction: (0, service_discovery_1.serviceBookingAction)("ERROR"),
                    })),
                });
                this.applyCategory();
            }
            finally {
                this.setData({ loading: false, therapistLoading: false });
                this.applyCategory();
            }
        })();
        this.discoveryRequest = request;
        try {
            await request;
        }
        finally {
            this.discoveryRequest = null;
        }
    },
    async loadTherapists() {
        return this.loadServices();
    },
    selectCategory(event) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        this.setData({ activeCategory: event.currentTarget.dataset.key });
        this.applyCategory();
    },
    applyCategory() {
        const allServices = this.data.allServices.map((service) => {
            const availability = this.data.loading
                ? {
                    bookingState: "LOADING",
                    therapistId: "",
                    bookableCount: 0,
                }
                : this.data.error
                    ? {
                        bookingState: "ERROR",
                        therapistId: "",
                        bookableCount: 0,
                    }
                    : (0, service_discovery_1.serviceBookingState)(service.id, {
                        therapists: this.data.allTherapists,
                        profileCount: this.data.profileCount,
                        failedServiceIds: this.data.failedServiceIds,
                    });
            return {
                ...service,
                ...availability,
                bookingLabel: (0, service_discovery_1.serviceBookingLabel)(availability.bookingState),
                bookingAction: (0, service_discovery_1.serviceBookingAction)(availability.bookingState),
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
        if (!(0, auth_1.hasVerifiedCustomerSession)()) {
            this.setData({
                newcomerClaimed: false,
                newcomerAvailable: true,
                newcomerReason: "登录后领取新人优惠券",
                newcomerError: "",
            });
            return;
        }
        try {
            const entitlement = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/newcomer-coupons"));
            this.setData({
                newcomerClaimed: entitlement.claimed,
                newcomerAvailable: entitlement.eligible,
                newcomerReason: entitlement.reason,
                newcomerError: "",
            });
        }
        catch (error) {
            this.setData({
                newcomerAvailable: false,
                newcomerError: error instanceof Error ? error.message : "新人优惠券读取失败",
            });
        }
    },
    async claimNewcomer() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || this.data.newcomerBusy)
            return;
        if (this.data.newcomerClaimed) {
            this.openNewcomer();
            return;
        }
        this.setData({ newcomerBusy: true, newcomerError: "" });
        try {
            const entitlement = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/newcomer-coupons"), "POST", {});
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
        }
        catch (error) {
            this.setData({
                newcomerError: error instanceof Error ? error.message : "领取失败，请重试",
            });
        }
        finally {
            this.setData({ newcomerBusy: false });
        }
    },
    async loadPublicConfig() {
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                serviceCity: config.serviceCity,
                amapMiniappKey: config.map.miniappKey,
            });
            return config;
        }
        catch {
            // The city fallback remains visible while the public API is unavailable.
            return null;
        }
    },
    async prepareLocation() {
        await this.loadPublicConfig();
        if (!this.data.autoLocationTried)
            await this.locateCity();
    },
    async locateCity() {
        if (this.data.locationBusy)
            return;
        this.setData({
            locationBusy: true,
            locationError: "",
            autoLocationTried: true,
            locationLabel: "正在获取当前位置…",
        });
        try {
            const point = await (0, amap_1.getGcj02Location)();
            const address = await (0, amap_1.reverseGeocode)(this.data.amapMiniappKey, point);
            this.setData({
                locationLabel: `已定位 · ${address.detail.slice(0, 18)}`,
            });
        }
        catch (error) {
            this.setData({
                locationLabel: `${this.data.serviceCity}全域服务`,
                locationError: error instanceof Error ? error.message : "当前位置获取失败",
            });
        }
        finally {
            this.setData({ locationBusy: false });
        }
    },
    chooseAddress() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (this.data.locationError) {
            void this.locateCity();
            return;
        }
        wx.navigateTo({ url: "/pages/addresses/index" });
    },
    bookNow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.switchTab({ url: "/pages/services/index" });
    },
    openServices() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.switchTab({ url: "/pages/services/index" });
    },
    openTherapists() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.navigateTo({ url: "/pages/therapists/index" });
    },
    openOrders() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.navigateTo({ url: "/pages/orders/index" });
    },
    openNewcomer() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.navigateTo({ url: "/pages/coupons/index" });
    },
    requireAccess() {
        (0, auth_1.requireVerifiedCustomerAccess)();
    },
    retryServices() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        void this.loadServices();
    },
    openTherapist(event) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const id = event.currentTarget.dataset.id;
        if (!id ||
            !this.data.therapists.some((therapist) => therapist.id === id && therapist.bookable))
            return;
        wx.navigateTo({
            url: `/pages/therapist-detail/index?id=${encodeURIComponent(id)}`,
        });
    },
    bookService(e) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const slug = e.currentTarget.dataset.slug;
        const service = this.data.allServices.find((item) => item.slug === slug);
        if (!service)
            return;
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
                title: service.bookingState === "NO_PROFILE"
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

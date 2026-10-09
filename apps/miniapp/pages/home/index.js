"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
const amap_1 = require("../../utils/amap");
const customer_center_1 = require("../../utils/customer-center");
const therapists_1 = require("../../utils/therapists");
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
    data: {
        allServices: [],
        services: [],
        allTherapists: [],
        therapists: [],
        therapistLoading: false,
        therapistError: "",
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
            this.loadTherapists(),
            this.prepareLocation(),
            this.loadNewcomer(),
        ]);
    },
    async loadServices() {
        this.setData({ loading: true, error: "" });
        try {
            const services = await (0, api_1.api)("/catalog/services");
            this.setData({
                allServices: services
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
                    artwork: service.category === "FOOT_CARE" ||
                        normalizeName(service.name).includes("采耳")
                        ? "care"
                        : "spa",
                })),
            });
            this.applyCategory();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "服务目录加载失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async loadTherapists() {
        this.setData({ therapistLoading: true, therapistError: "" });
        try {
            const [therapists, profiles] = await Promise.all([
                (0, therapists_1.loadPublicTherapists)(),
                (0, api_1.api)("/technicians"),
            ]);
            const profileOrder = new Map(profiles.map((profile, index) => [profile.technicianId, index]));
            const bookableTherapists = therapists
                .filter((therapist) => therapist.publishedProfile && therapist.bookable)
                .sort((left, right) => {
                var _a, _b;
                return ((_a = profileOrder.get(left.id)) !== null && _a !== void 0 ? _a : profiles.length) -
                    ((_b = profileOrder.get(right.id)) !== null && _b !== void 0 ? _b : profiles.length);
            })
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
        }
        catch (error) {
            this.setData({
                therapists: [],
                allTherapists: [],
                therapistError: error instanceof Error ? error.message : "技师信息读取失败",
            });
            this.applyCategory();
        }
        finally {
            this.setData({ therapistLoading: false });
        }
    },
    selectCategory(event) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        this.setData({ activeCategory: event.currentTarget.dataset.key });
        this.applyCategory();
    },
    applyCategory() {
        const allServices = this.data.allServices.map((service) => {
            var _a, _b;
            const matches = this.data.allTherapists.filter((therapist) => therapist.services.some((item) => item.id === service.id && item.slots.length > 0));
            return {
                ...service,
                therapistId: (_b = (_a = matches[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : "",
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
        void Promise.all([this.loadServices(), this.loadTherapists()]);
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
        if (!service.therapistId) {
            wx.showToast({ title: "该项目暂无可预约技师", icon: "none" });
            return;
        }
        wx.navigateTo({
            url: `/pages/therapist-detail/index?id=${encodeURIComponent(service.therapistId)}&slug=${encodeURIComponent(service.slug)}`,
        });
    },
});

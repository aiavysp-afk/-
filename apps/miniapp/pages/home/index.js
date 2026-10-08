"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
const amap_1 = require("../../utils/amap");
const categoryLabels = {
    MASSAGE: "按摩舒缓",
    SPA_RELAXATION: "SPA 放松",
    FOOT_CARE: "足部养护",
};
Page({
    data: {
        services: [],
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
        await Promise.all([this.loadServices(), this.prepareLocation()]);
    },
    async loadServices() {
        this.setData({ loading: true, error: "" });
        try {
            const services = await (0, api_1.api)("/catalog/services");
            this.setData({
                services: services.slice(0, 3).map((service, index) => ({
                    ...service,
                    duration: `${service.durationMinutes} 分钟`,
                    price: (0, api_1.money)(service.priceFen),
                    categoryLabel: categoryLabels[service.category],
                    tone: ["sage", "tea", "clay"][index % 3],
                })),
            });
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
        if (this.data.locationError) {
            void this.locateCity();
            return;
        }
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
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
    bookService(e) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const slug = e.currentTarget.dataset.slug;
        if (!slug)
            return;
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(slug)}`,
        });
    },
});

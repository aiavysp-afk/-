"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
Page({
    data: {
        services: [],
        loading: false,
        error: "",
        serviceCity: "郑州市",
        accessReady: false,
    },
    async onShow() {
        this.setData({ accessReady: (0, auth_1.hasVerifiedCustomerSession)() });
        (0, tab_bar_1.syncCustomTabBar)(this, 0);
        await Promise.all([this.loadServices(), this.loadPublicConfig()]);
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
            this.setData({ serviceCity: config.serviceCity });
        }
        catch {
            // The city fallback remains visible while the public API is unavailable.
        }
    },
    chooseAddress() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        wx.switchTab({ url: "/pages/services/index" });
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

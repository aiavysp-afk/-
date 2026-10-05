"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const customer_service_1 = require("../../utils/customer-service");
const CUSTOMER_SERVICE_FALLBACK = {
    provider: "wecom",
    available: true,
    corpId: "ww715e0d876d9f3cb4",
    url: "https://work.weixin.qq.com/kfid/kfca6852bf5e57656af",
};
Page({
    data: {
        services: [],
        loading: false,
        error: "",
        serviceCity: "郑州市",
        customerService: CUSTOMER_SERVICE_FALLBACK,
    },
    async onShow() {
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
        this.setData({ customerService: CUSTOMER_SERVICE_FALLBACK });
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                serviceCity: config.serviceCity,
                customerService: config.customerService,
            });
        }
        catch {
            // The verified public customer-service fallback remains usable during API maintenance.
        }
    },
    chooseAddress() {
        wx.switchTab({ url: "/pages/services/index" });
    },
    bookNow() {
        wx.switchTab({ url: "/pages/services/index" });
    },
    bookService(e) {
        const slug = e.currentTarget.dataset.slug;
        if (!slug)
            return;
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(slug)}`,
        });
    },
    callSupport() {
        (0, customer_service_1.openWecomCustomerService)(this.data.customerService);
    },
});

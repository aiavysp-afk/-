"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
const therapists_1 = require("../../utils/therapists");
Page({
    data: {
        tabs: ["推荐", "服务项目", "技师风采", "安心保障"],
        activeTab: 0,
        services: [],
        therapists: [],
        loading: false,
        error: "",
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        (0, tab_bar_1.syncCustomTabBar)(this, 1);
        if (!this.data.services.length && !this.data.therapists.length)
            await this.load();
    },
    async load() {
        this.setData({ loading: true, error: "" });
        try {
            const [servicesResult, therapistsResult] = await Promise.allSettled([
                (0, api_1.api)("/catalog/services"),
                (0, therapists_1.loadPublicTherapists)(),
            ]);
            const services = servicesResult.status === "fulfilled"
                ? servicesResult.value.slice(0, 6).map((service, index) => ({
                    ...service,
                    price: (0, api_1.money)(service.priceFen),
                    tone: index % 4,
                }))
                : [];
            const therapists = therapistsResult.status === "fulfilled"
                ? therapistsResult.value.slice(0, 6)
                : [];
            this.setData({ services, therapists });
            if (!services.length && !therapists.length)
                throw new Error("暂无已发布的服务或技师资料");
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "发现内容读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    selectTab(event) {
        this.setData({ activeTab: Number(event.currentTarget.dataset.index) });
    },
    openService(event) {
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(event.currentTarget.dataset.slug)}`,
        });
    },
    openTherapist(event) {
        wx.navigateTo({
            url: `/pages/therapist-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`,
        });
    },
    openAllServices() {
        wx.switchTab({ url: "/pages/services/index" });
    },
    openAllTherapists() {
        wx.navigateTo({ url: "/pages/therapists/index" });
    },
});

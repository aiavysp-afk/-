"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
const service_discovery_1 = require("../../utils/service-discovery");
Page({
    data: {
        categories: ["全部", "按摩舒缓", "SPA 放松", "足部养护"],
        active: 0,
        all: [],
        services: [],
        loading: false,
        error: "",
        scheduleError: "",
        showEmptyServices: false,
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        (0, tab_bar_1.syncCustomTabBar)(this, 2);
        await this.load();
    },
    async load() {
        if (this.data.loading)
            return;
        this.setData({
            loading: true,
            error: "",
            scheduleError: "",
            showEmptyServices: false,
            all: [],
            services: [],
        });
        try {
            const snapshot = await (0, service_discovery_1.loadPublicServiceDiscovery)();
            const all = snapshot.services.map((item) => {
                const availability = (0, service_discovery_1.serviceBookingState)(item.id, snapshot);
                return {
                    ...item,
                    price: (0, api_1.money)(item.priceFen),
                    ...availability,
                    bookingLabel: (0, service_discovery_1.serviceBookingLabel)(availability.bookingState),
                    bookingAction: (0, service_discovery_1.serviceBookingAction)(availability.bookingState),
                };
            });
            this.setData({
                all,
                scheduleError: snapshot.failedServiceIds.length
                    ? "部分项目排班读取失败，请重试确认可约状态。"
                    : "",
            });
            this.filter();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "目录加载失败",
            });
        }
        finally {
            this.setData({
                loading: false,
                showEmptyServices: !this.data.error && this.data.services.length === 0,
            });
        }
    },
    select(e) {
        this.setData({ active: Number(e.currentTarget.dataset.index) });
        this.filter();
    },
    filter() {
        const category = ["", "MASSAGE", "SPA_RELAXATION", "FOOT_CARE"][this.data.active];
        const services = this.data.all.filter((item) => !category || item.category === category);
        this.setData({
            services,
            showEmptyServices: !this.data.loading && !this.data.error && services.length === 0,
        });
    },
    book(e) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || this.data.loading)
            return;
        const service = this.data.all.find((item) => item.slug === e.currentTarget.dataset.slug);
        if (!service)
            return;
        if (service.bookingState === "ERROR") {
            void this.load();
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
    openServiceDetail(e) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const service = this.data.all.find((item) => item.slug === e.currentTarget.dataset.slug);
        if (!service)
            return;
        wx.navigateTo({ url: `/pages/service-detail/index?slug=${encodeURIComponent(service.slug)}` });
    },
});

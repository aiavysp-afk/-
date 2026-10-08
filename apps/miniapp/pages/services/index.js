"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const tab_bar_1 = require("../../utils/tab-bar");
Page({
    data: {
        categories: ["全部", "按摩舒缓", "SPA 放松", "足部养护"],
        active: 0,
        all: [],
        services: [],
        loading: false,
        error: "",
        showEmptyServices: false,
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        (0, tab_bar_1.syncCustomTabBar)(this, 1);
        await this.load();
    },
    async load() {
        this.setData({ loading: true, error: "", showEmptyServices: false });
        try {
            const all = (await (0, api_1.api)("/catalog/services")).map((item) => ({ ...item, price: (0, api_1.money)(item.priceFen) }));
            this.setData({ all });
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
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(e.currentTarget.dataset.slug)}`,
        });
    },
});

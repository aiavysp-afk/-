"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
Page({
    data: {
        categories: ["全部", "按摩舒缓", "SPA 放松", "足部养护"],
        active: 0,
        all: [],
        services: [],
        loading: false,
        error: "",
    },
    async onShow() {
        await this.load();
    },
    async load() {
        this.setData({ loading: true, error: "" });
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
            this.setData({ loading: false });
        }
    },
    select(e) {
        this.setData({ active: Number(e.currentTarget.dataset.index) });
        this.filter();
    },
    filter() {
        const category = ["", "MASSAGE", "SPA_RELAXATION", "FOOT_CARE"][this.data.active];
        this.setData({
            services: this.data.all.filter((item) => !category || item.category === category),
        });
    },
    book(e) {
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(e.currentTarget.dataset.slug)}`,
        });
    },
});

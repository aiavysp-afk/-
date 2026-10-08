"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tab_bar_1 = require("../../utils/tab-bar");
const therapists_1 = require("../../utils/therapists");
Page({
    data: {
        activeFilter: "ALL",
        bookingOpen: false,
        error: "",
        filters: [
            { key: "ALL", label: "全部技师" },
            { key: "TODAY", label: "今日可约" },
            { key: "TOMORROW", label: "明日可约" },
        ],
        loading: false,
        selectedTherapist: null,
        therapists: [],
        visibleTherapists: [],
    },
    async onShow() {
        (0, tab_bar_1.syncCustomTabBar)(this, 2);
        await this.load();
    },
    async load() {
        if (this.data.loading)
            return;
        this.setData({ loading: true, error: "" });
        try {
            const therapists = await (0, therapists_1.loadPublicTherapists)();
            this.setData({ therapists });
            this.applyFilter();
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "技师排班读取失败",
                therapists: [],
                visibleTherapists: [],
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    selectFilter(event) {
        this.setData({ activeFilter: event.currentTarget.dataset.key });
        this.applyFilter();
    },
    applyFilter() {
        const visibleTherapists = this.data.therapists.filter((therapist) => {
            if (this.data.activeFilter === "TODAY")
                return therapist.todaySlotCount > 0;
            if (this.data.activeFilter === "TOMORROW")
                return therapist.tomorrowSlotCount > 0;
            return true;
        });
        this.setData({ visibleTherapists });
    },
    openDetail(event) {
        wx.navigateTo({
            url: `/pages/therapist-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`,
        });
    },
    openBooking(event) {
        const selectedTherapist = this.data.therapists.find((therapist) => therapist.id === event.currentTarget.dataset.id);
        if (!(selectedTherapist === null || selectedTherapist === void 0 ? void 0 : selectedTherapist.bookable)) {
            wx.showToast({ title: "该技师当前暂无可约时段", icon: "none" });
            return;
        }
        this.setData({ selectedTherapist, bookingOpen: true });
    },
    closeBooking() {
        this.setData({ bookingOpen: false, selectedTherapist: null });
    },
    keepBookingOpen() { },
    chooseService(event) {
        const therapist = this.data.selectedTherapist;
        const service = therapist === null || therapist === void 0 ? void 0 : therapist.services.find((item) => item.slug === event.currentTarget.dataset.slug);
        if (!therapist || !service)
            return;
        this.closeBooking();
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(service.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
        });
    },
});

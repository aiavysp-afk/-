"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
const technician_photos_1 = require("../../utils/technician-photos");
const therapists_1 = require("../../utils/therapists");
Page({
    data: {
        activeFilter: "ALL",
        activeSort: "EARLIEST",
        bookingOpen: false,
        error: "",
        filters: [
            { key: "ALL", label: "全部技师" },
            { key: "BOOKABLE", label: "当前可约" },
            { key: "TODAY", label: "今日可约" },
            { key: "TOMORROW", label: "明日可约" },
        ],
        sorts: [
            { key: "EARLIEST", label: "最早可约" },
            { key: "RATING", label: "评分优先" },
            { key: "ORDERS", label: "服务单量" },
        ],
        loading: false,
        canUploadOwnPhotos: false,
        selectedTherapist: null,
        therapists: [],
        visibleTherapists: [],
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        this.setData({ canUploadOwnPhotos: (0, technician_photos_1.canUploadOwnTechnicianPhotos)() });
        void (0, technician_photos_1.refreshOwnTechnicianPhotoAccess)().then((allowed) => this.setData({ canUploadOwnPhotos: allowed })).catch(() => this.setData({ canUploadOwnPhotos: false }));
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
    openOwnPhotos() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || !this.data.canUploadOwnPhotos)
            return;
        wx.navigateTo({ url: "/pages/technician-photos/index" });
    },
    selectFilter(event) {
        this.setData({ activeFilter: event.currentTarget.dataset.key });
        this.applyFilter();
    },
    selectSort(event) {
        this.setData({ activeSort: event.currentTarget.dataset.key });
        this.applyFilter();
    },
    applyFilter() {
        const visibleTherapists = this.data.therapists.filter((therapist) => {
            if (this.data.activeFilter === "BOOKABLE")
                return therapist.bookable;
            if (this.data.activeFilter === "TODAY")
                return therapist.todaySlotCount > 0;
            if (this.data.activeFilter === "TOMORROW")
                return therapist.tomorrowSlotCount > 0;
            return true;
        });
        visibleTherapists.sort((left, right) => {
            if (this.data.activeSort === "RATING")
                return ((Number.parseFloat(right.ratingLabel) || 0) -
                    (Number.parseFloat(left.ratingLabel) || 0));
            if (this.data.activeSort === "ORDERS")
                return ((Number.parseInt(right.orderCountLabel, 10) || 0) -
                    (Number.parseInt(left.orderCountLabel, 10) || 0));
            const leftTime = left.services
                .flatMap((service) => service.slots)
                .map((slot) => slot.startsAt)
                .sort()[0];
            const rightTime = right.services
                .flatMap((service) => service.slots)
                .map((slot) => slot.startsAt)
                .sort()[0];
            return (leftTime !== null && leftTime !== void 0 ? leftTime : "9999").localeCompare(rightTime !== null && rightTime !== void 0 ? rightTime : "9999");
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

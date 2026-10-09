"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const therapists_1 = require("../../utils/therapists");
const auth_1 = require("../../utils/auth");
const technician_photos_1 = require("../../utils/technician-photos");
const DETAIL_TABS = [
    { key: "recommended", label: "推荐项目" },
    { key: "all", label: "全部项目" },
    { key: "reviews", label: "用户评论" },
    { key: "updates", label: "商户动态" },
];
const recommendedServices = (services, selectedSlug) => services.filter((service) => service.featured || service.slug === selectedSlug);
Page({
    data: {
        error: "",
        loading: true,
        canUploadOwnPhotos: false,
        therapist: null,
        selectedServiceSlug: "",
        selectedServiceName: "",
        activeTab: "recommended",
        tabs: DETAIL_TABS,
        displayedServices: [],
    },
    async onLoad(options) {
        var _a, _b, _c;
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        this.setData({ canUploadOwnPhotos: (0, technician_photos_1.canUploadOwnTechnicianPhotos)() });
        void (0, technician_photos_1.refreshOwnTechnicianPhotoAccess)()
            .then((allowed) => this.setData({ canUploadOwnPhotos: allowed }))
            .catch(() => this.setData({ canUploadOwnPhotos: false }));
        if (!options.id) {
            this.setData({ error: "缺少技师参数", loading: false });
            return;
        }
        try {
            const therapist = await (0, therapists_1.loadPublicTherapist)(options.id);
            const selected = options.slug
                ? therapist.services.find((service) => service.slug === options.slug)
                : undefined;
            if (options.slug && !selected) {
                wx.showToast({ title: "所选项目当前暂无可约时间", icon: "none" });
            }
            const orderedTherapist = {
                ...therapist,
                // Keep the selected real service first without removing other services.
                services: selected
                    ? [
                        selected,
                        ...therapist.services.filter((service) => service.slug !== selected.slug),
                    ]
                    : therapist.services,
            };
            this.setData({
                therapist: orderedTherapist,
                selectedServiceSlug: (_a = selected === null || selected === void 0 ? void 0 : selected.slug) !== null && _a !== void 0 ? _a : "",
                selectedServiceName: (_b = selected === null || selected === void 0 ? void 0 : selected.name) !== null && _b !== void 0 ? _b : "",
                displayedServices: recommendedServices(orderedTherapist.services, (_c = selected === null || selected === void 0 ? void 0 : selected.slug) !== null && _c !== void 0 ? _c : ""),
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "技师资料读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    openOwnPhotos() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || !this.data.canUploadOwnPhotos)
            return;
        wx.navigateTo({ url: "/pages/technician-photos/index" });
    },
    selectTab(event) {
        var _a, _b;
        const activeTab = event.currentTarget.dataset.tab;
        if (!DETAIL_TABS.some((tab) => tab.key === activeTab))
            return;
        const services = (_b = (_a = this.data.therapist) === null || _a === void 0 ? void 0 : _a.services) !== null && _b !== void 0 ? _b : [];
        this.setData({
            activeTab: activeTab,
            displayedServices: activeTab === "all"
                ? services
                : activeTab === "recommended"
                    ? recommendedServices(services, this.data.selectedServiceSlug)
                    : [],
        });
    },
    showAllProjects() {
        var _a, _b;
        this.setData({
            activeTab: "all",
            displayedServices: (_b = (_a = this.data.therapist) === null || _a === void 0 ? void 0 : _a.services) !== null && _b !== void 0 ? _b : [],
        });
    },
    openService(event) {
        const therapist = this.data.therapist;
        const slug = event.currentTarget.dataset.slug;
        if (!therapist || !slug || !(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (!therapist.services.some((service) => service.slug === slug))
            return;
        wx.navigateTo({
            url: `/pages/service-detail/index?slug=${encodeURIComponent(slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
        });
    },
    book(event) {
        const therapist = this.data.therapist;
        if (!therapist || !(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const service = therapist.services.find((item) => item.slug === event.currentTarget.dataset.slug);
        if (!(service === null || service === void 0 ? void 0 : service.slots.length)) {
            wx.showToast({ title: "该项目当前暂无可约时间", icon: "none" });
            return;
        }
        wx.navigateTo({
            url: `/pages/booking/index?slug=${encodeURIComponent(event.currentTarget.dataset.slug)}&therapistId=${encodeURIComponent(therapist.id)}`,
        });
    },
});

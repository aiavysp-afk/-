"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const service_discovery_1 = require("../../utils/service-discovery");
const categories = {
    MASSAGE: "日常保健",
    SPA_RELAXATION: "SPA 放松",
    FOOT_CARE: "足部养护",
};
Page({
    requestVersion: 0,
    data: {
        slug: "",
        preferredTherapistId: "",
        loading: false,
        error: "",
        service: null,
        activeTab: "INTRO",
        tabs: [
            { key: "INTRO", label: "项目介绍" },
            { key: "STEPS", label: "服务流程" },
            { key: "REVIEWS", label: "用户评价" },
            { key: "TECHNICIANS", label: "选择技师" },
        ],
        reviews: [],
        reviewsLoading: false,
        reviewsError: "",
        therapists: [],
        availabilityLoading: false,
        availabilityError: "",
        availabilityLabel: "读取可约状态…",
        reminders: [
            "下单前阅读项目说明、服务范围和取消退款规则。",
            "确认真实服务地址、门牌号和可联系的手机号码。",
            "仅选择后台提供的真实技师和预约时段。",
            "服务前沟通身体状态、需求与可接受的力度；不适时暂停。",
            "确认用品清洁及一次性耗材；有疑问先联系平台客服。",
            "妥善保管贵重物品，提供安全、合适的服务空间。",
            "只在平台内支付，不接受私下转账或临时加价。",
            "不提出涉及私密部位、违法或超出公示范围的要求。",
            "保留订单记录；服务争议及退款通过平台处理。",
        ],
        assurances: [
            {
                mark: "审",
                title: "公开资料可查",
                copy: "照片与资质以后台审核发布内容为准",
            },
            {
                mark: "¥",
                title: "服务器核价",
                copy: "项目价格、优惠及最终实付均由服务器确认",
            },
            {
                mark: "行",
                title: "免出行费",
                copy: "下单报价出行费为零，不另收交通费用",
            },
            {
                mark: "单",
                title: "订单留痕",
                copy: "预约、付款与售后记录可在订单页查看",
            },
        ],
    },
    async onLoad(options) {
        var _a, _b;
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (!options.slug || options.slug.length > 160) {
            this.setData({ error: "缺少有效的项目参数" });
            return;
        }
        this.setData({
            slug: options.slug,
            preferredTherapistId: (_b = (_a = options.therapistId) === null || _a === void 0 ? void 0 : _a.slice(0, 160)) !== null && _b !== void 0 ? _b : "",
        });
        await this.load();
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        if (this.data.slug && !this.data.loading)
            await this.load();
    },
    onUnload() {
        this.requestVersion += 1;
    },
    async load() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() ||
            !this.data.slug ||
            this.data.loading)
            return;
        const version = ++this.requestVersion;
        const slug = this.data.slug;
        this.setData({
            loading: true,
            error: "",
            service: null,
            therapists: [],
            reviews: [],
            reviewsError: "",
            availabilityError: "",
            reviewsLoading: false,
            availabilityLoading: false,
            availabilityLabel: "读取可约状态…",
        });
        try {
            const item = await (0, api_1.api)(`/catalog/services/${encodeURIComponent(slug)}`);
            if (version !== this.requestVersion)
                return;
            if (item.slug !== slug)
                throw new Error("项目资料不匹配，请重新打开");
            this.setData({
                service: {
                    ...item,
                    price: (0, api_1.money)(item.priceFen),
                    categoryLabel: categories[item.category],
                    artwork: item.category === "FOOT_CARE" || item.name.includes("采耳")
                        ? "care"
                        : "spa",
                    process: item.steps.map((title, index) => ({
                        number: String(index + 1).padStart(2, "0"),
                        title,
                    })),
                },
                reviewsLoading: true,
                availabilityLoading: true,
            });
            await Promise.all([
                this.loadReviews(slug, version),
                this.loadTherapists(item, version),
            ]);
        }
        catch (error) {
            if (version === this.requestVersion)
                this.setData({
                    error: error instanceof Error ? error.message : "项目详情读取失败",
                    service: null,
                    therapists: [],
                });
        }
        finally {
            if (version === this.requestVersion)
                this.setData({ loading: false });
        }
    },
    async loadReviews(slug, version) {
        try {
            const reviews = await (0, api_1.api)(`/catalog/services/${encodeURIComponent(slug)}/reviews`);
            if (version !== this.requestVersion)
                return;
            this.setData({
                reviews: reviews.map((review) => ({
                    ...review,
                    stars: "★".repeat(Math.max(0, Math.min(5, review.rating))),
                    dateLabel: (0, api_1.shanghaiTime)(review.createdAt).slice(0, 10),
                })),
            });
        }
        catch (error) {
            if (version === this.requestVersion)
                this.setData({
                    reviewsError: error instanceof Error ? error.message : "评价暂时读取失败",
                });
        }
        finally {
            if (version === this.requestVersion)
                this.setData({ reviewsLoading: false });
        }
    },
    async loadTherapists(service, version) {
        try {
            const snapshot = await (0, service_discovery_1.loadPublicServiceDiscovery)();
            if (version !== this.requestVersion)
                return;
            if (!snapshot.services.some((item) => item.id === service.id && item.slug === service.slug))
                throw new Error("项目已调整，请刷新后再预约");
            if (snapshot.failedServiceIds.includes(service.id))
                throw new Error("该项目排班读取失败，请重试");
            const therapists = snapshot.therapists.filter((therapist) => therapist.publishedProfile &&
                therapist.bookable &&
                therapist.services.some((item) => item.id === service.id && item.slots.length > 0));
            // A link may highlight an existing technician, never create capacity or
            // select an unpublished/no-slot identity from the query parameters.
            therapists.sort((left, right) => Number(right.id === this.data.preferredTherapistId) -
                Number(left.id === this.data.preferredTherapistId));
            this.setData({
                therapists,
                availabilityLabel: therapists.length
                    ? `${therapists.length}位技师可约`
                    : "预约时段待开放",
            });
        }
        catch (error) {
            if (version === this.requestVersion)
                this.setData({
                    therapists: [],
                    availabilityLabel: "排班待确认",
                    availabilityError: error instanceof Error ? error.message : "排班读取失败",
                });
        }
        finally {
            if (version === this.requestVersion)
                this.setData({ availabilityLoading: false });
        }
    },
    selectTab(event) {
        const key = event.currentTarget.dataset.key;
        if (this.data.tabs.some((tab) => tab.key === key))
            this.setData({ activeTab: key });
    },
    chooseTechnician() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || !this.data.service)
            return;
        this.setData({ activeTab: "TECHNICIANS" });
        wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    },
    openTherapist(event) {
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || this.data.availabilityLoading)
            return;
        const id = event.currentTarget.dataset.id;
        const therapist = this.data.therapists.find((item) => item.id === id && item.bookable);
        if (!therapist || !this.data.service)
            return;
        wx.navigateTo({
            url: `/pages/therapist-detail/index?id=${encodeURIComponent(therapist.id)}&slug=${encodeURIComponent(this.data.service.slug)}`,
        });
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
});

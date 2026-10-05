"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
Page({
    data: {
        service: null,
        price: "",
        date: "",
        slots: [],
        selected: -1,
        contactName: "",
        phone: "",
        detail: "",
        addressSuggestionAvailable: false,
        addressVerificationRequired: false,
        addressVerificationId: "",
        orderSubmissionAttempted: false,
        serviceCity: "",
        suggestions: [],
        suggestionBusy: false,
        busy: false,
        error: "",
        consent: false,
        reservationId: "",
        orderKey: "",
        quote: "",
    },
    async onLoad(options) {
        void this.loadMapConfig();
        try {
            if (!options.slug)
                throw new Error("缺少服务参数");
            const service = await (0, api_1.api)(`/catalog/services/${encodeURIComponent(options.slug)}`);
            this.setData({
                service,
                price: (0, api_1.money)(service.priceFen),
                date: new Date(Date.now() + 8 * 3600000 + 86400000)
                    .toISOString()
                    .slice(0, 10),
            });
            await this.loadSlots();
        }
        catch (error) {
            this.fail(error);
        }
    },
    async loadMapConfig() {
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                addressSuggestionAvailable: config.features.addressSuggestionAvailable,
                addressVerificationRequired: config.features.addressVerificationRequired,
                serviceCity: config.serviceCity,
            });
        }
        catch {
            // Address search is an optional enhancement; manual entry remains usable.
            this.setData({ addressSuggestionAvailable: false });
        }
    },
    fail(error) {
        this.setData({
            error: error instanceof Error ? error.message : "请求失败",
        });
    },
    async loadSlots() {
        if (!this.data.service)
            return;
        this.setData({ error: "", selected: -1 });
        try {
            const slots = await (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(this.data.service.id)}&date=${this.data.date}`);
            this.setData({
                slots: slots.map((slot) => ({
                    ...slot,
                    label: (0, api_1.shanghaiTime)(slot.startsAt),
                    key: `${slot.therapistId}-${slot.startsAt}`,
                })),
            });
        }
        catch (error) {
            this.fail(error);
        }
    },
    async dateChanged(e) {
        if (this.data.reservationId)
            return;
        this.setData({ date: e.detail.value });
        await this.loadSlots();
    },
    select(e) {
        if (!this.data.reservationId)
            this.setData({ selected: Number(e.currentTarget.dataset.index) });
    },
    input(e) {
        const field = e.currentTarget.dataset.field;
        if (["contactName", "phone", "detail"].includes(field) &&
            !this.data.orderSubmissionAttempted)
            this.setData({
                [field]: e.detail.value,
                ...(field === "detail"
                    ? { suggestions: [], addressVerificationId: "" }
                    : {}),
            });
    },
    async searchAddress() {
        if (this.data.suggestionBusy ||
            !this.data.addressSuggestionAvailable ||
            this.data.orderSubmissionAttempted)
            return;
        const keyword = this.data.detail.trim();
        if (keyword.length < 2 || keyword.length > 32) {
            this.fail(new Error("请输入 2 至 32 个字的地址关键词"));
            return;
        }
        this.setData({ suggestionBusy: true, error: "", suggestions: [] });
        try {
            if (!(0, auth_1.getStoredSession)())
                await (0, auth_1.loginWithWechat)();
            const suggestions = await (0, api_1.api)(`/locations/address-suggestions?keyword=${encodeURIComponent(keyword)}`);
            this.setData({ suggestions });
            if (!suggestions.length)
                this.fail(new Error("当前服务城市内未找到匹配地址，请继续手填"));
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ suggestionBusy: false });
        }
    },
    selectAddress(e) {
        if (this.data.orderSubmissionAttempted)
            return;
        const suggestion = this.data.suggestions[Number(e.currentTarget.dataset.index)];
        if (!suggestion)
            return;
        const detail = `${suggestion.title} ${suggestion.address}`
            .trim()
            .slice(0, 200);
        this.setData({ detail, suggestions: [], addressVerificationId: "" });
    },
    consentChanged(e) {
        this.setData({ consent: e.detail.value.includes("agree") });
    },
    async create() {
        if (this.data.busy)
            return;
        const slot = this.data.slots[this.data.selected], service = this.data.service;
        if (!service ||
            !slot ||
            !this.data.consent ||
            this.data.contactName.trim().length < 2 ||
            !/^1\d{10}$/.test(this.data.phone) ||
            this.data.detail.trim().length < 5) {
            this.fail(new Error("请选择时段，填写有效地址与手机号码，并确认服务边界"));
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            if (!(0, auth_1.getStoredSession)())
                await (0, auth_1.loginWithWechat)();
            if (!this.data.reservationId) {
                const hold = await (0, api_1.api)("/booking-holds", "POST", {
                    serviceId: service.id,
                    therapistId: slot.therapistId,
                    startsAt: slot.startsAt,
                });
                this.setData({ reservationId: hold.id, orderKey: (0, api_1.newKey)() });
            }
            if (this.data.addressVerificationRequired &&
                !this.data.addressVerificationId) {
                const verification = await (0, api_1.api)("/locations/address-verifications", "POST", {
                    reservationId: this.data.reservationId,
                    detail: this.data.detail.trim(),
                });
                this.setData({ addressVerificationId: verification.id });
            }
            if (!this.data.quote) {
                const quote = await (0, api_1.api)("/orders/quote", "POST", {
                    reservationId: this.data.reservationId,
                });
                this.setData({ quote: (0, api_1.money)(quote.payableFen) });
            }
            // Once an order request leaves the device, keep the request immutable so
            // an uncertain network result can be retried with the same fingerprint.
            this.setData({ orderSubmissionAttempted: true });
            await (0, api_1.api)("/orders", "POST", {
                reservationId: this.data.reservationId,
                address: {
                    contactName: this.data.contactName.trim(),
                    phone: this.data.phone,
                    detail: this.data.detail.trim(),
                },
                ...(this.data.addressVerificationId
                    ? { addressVerificationId: this.data.addressVerificationId }
                    : {}),
            }, this.data.orderKey);
            this.setData({
                reservationId: "",
                orderKey: "",
                addressVerificationId: "",
                orderSubmissionAttempted: false,
            });
            wx.showToast({ title: "订单已创建，请到订单页支付", icon: "none" });
            wx.switchTab({ url: "/pages/orders/index" });
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ busy: false });
        }
    },
    onUnload() {
        this.setData({
            contactName: "",
            phone: "",
            detail: "",
            suggestions: [],
            addressVerificationId: "",
            orderSubmissionAttempted: false,
        });
    },
});

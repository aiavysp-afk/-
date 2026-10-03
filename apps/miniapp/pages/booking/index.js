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
        busy: false,
        error: "",
        consent: false,
        reservationId: "",
        orderKey: "",
        quote: "",
    },
    async onLoad(options) {
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
            !this.data.reservationId)
            this.setData({ [field]: e.detail.value });
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
            if (!this.data.quote) {
                const quote = await (0, api_1.api)("/orders/quote", "POST", {
                    reservationId: this.data.reservationId,
                });
                this.setData({ quote: (0, api_1.money)(quote.payableFen) });
            }
            await (0, api_1.api)("/orders", "POST", {
                reservationId: this.data.reservationId,
                address: {
                    contactName: this.data.contactName.trim(),
                    phone: this.data.phone,
                    detail: this.data.detail.trim(),
                },
            }, this.data.orderKey);
            this.setData({ reservationId: "", orderKey: "" });
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
        this.setData({ contactName: "", phone: "", detail: "" });
    },
});

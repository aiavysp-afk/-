"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const amap_1 = require("../../utils/amap");
const booking_1 = require("../../utils/booking");
const categoryNames = {
    MASSAGE: "按摩舒缓",
    SPA_RELAXATION: "SPA 放松",
    FOOT_CARE: "足部养护",
};
Page({
    data: {
        service: null,
        price: "",
        categoryName: "",
        quantity: 1,
        appointmentMode: "soon",
        date: "",
        minDate: "",
        maxDate: "",
        slots: [],
        selected: -1,
        selectedSlotLabel: "",
        contactName: "",
        phone: "",
        detail: "",
        doorNumber: "",
        latitude: null,
        longitude: null,
        coordinateSystem: "GCJ-02",
        amapMiniappKey: "",
        locationBusy: false,
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
        quoteDetails: null,
        loggedIn: false,
        phoneVerified: false,
        loginBusy: false,
        loginError: "",
        preferredTherapistId: "",
    },
    async onLoad(options) {
        var _a;
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const session = (0, auth_1.getStoredSession)();
        this.setData({
            loggedIn: Boolean(session),
            phoneVerified: (session === null || session === void 0 ? void 0 : session.user.phoneVerified) === true,
            preferredTherapistId: (_a = options.therapistId) !== null && _a !== void 0 ? _a : "",
        });
        void this.loadMapConfig();
        try {
            if (!options.slug)
                throw new Error("缺少服务参数");
            const service = await (0, api_1.api)(`/catalog/services/${encodeURIComponent(options.slug)}`);
            this.setData({
                service,
                price: (0, api_1.money)(service.priceFen),
                categoryName: categoryNames[service.category],
                date: (0, booking_1.shanghaiDate)(),
                minDate: (0, booking_1.shanghaiDate)(),
                maxDate: (0, booking_1.shanghaiDate)(30),
            });
            await this.loadSlots();
        }
        catch (error) {
            this.fail(error);
        }
    },
    onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        const session = (0, auth_1.getStoredSession)();
        this.setData({
            loggedIn: Boolean(session),
            phoneVerified: (session === null || session === void 0 ? void 0 : session.user.phoneVerified) === true,
        });
    },
    async login() {
        if (this.data.loginBusy || this.data.loggedIn)
            return;
        this.setData({ loginBusy: true, loginError: "" });
        try {
            const session = await (0, auth_1.loginWithWechat)();
            this.setData({
                loggedIn: true,
                phoneVerified: session.user.phoneVerified === true,
            });
            wx.showToast({ title: "登录成功", icon: "success" });
            if ((0, auth_1.needsPhoneVerification)(session))
                (0, auth_1.goToPhoneVerification)();
        }
        catch (error) {
            this.setData({
                loginError: error instanceof Error ? error.message : "微信登录失败",
            });
        }
        finally {
            this.setData({ loginBusy: false });
        }
    },
    async loadMapConfig() {
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                addressSuggestionAvailable: config.features.addressSuggestionAvailable,
                addressVerificationRequired: config.features.addressVerificationRequired,
                serviceCity: config.serviceCity,
                amapMiniappKey: config.map.miniappKey,
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
        var _a, _b;
        if (!this.data.service)
            return;
        this.setData({ error: "", selected: -1 });
        try {
            const slots = await (0, api_1.api)(`/availability/slots?serviceId=${encodeURIComponent(this.data.service.id)}&date=${this.data.date}`);
            const slotViews = slots.map((slot) => ({
                ...slot,
                label: (0, api_1.shanghaiTime)(slot.startsAt).slice(11),
                key: `${slot.therapistId}-${slot.startsAt}`,
            }));
            const selected = (0, booking_1.pickSlotIndex)(slotViews, this.data.preferredTherapistId, this.data.appointmentMode);
            this.setData({
                slots: slotViews,
                selected,
                selectedSlotLabel: (_b = (_a = slotViews[selected]) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : "",
            });
        }
        catch (error) {
            this.fail(error);
        }
    },
    async dateChanged(e) {
        if (this.data.reservationId)
            return;
        this.setData({
            date: e.detail.value,
            selected: -1,
            selectedSlotLabel: "",
            quoteDetails: null,
        });
        await this.loadSlots();
    },
    async setAppointmentMode(e) {
        if (this.data.reservationId)
            return;
        const appointmentMode = e.currentTarget.dataset.mode;
        if (appointmentMode === this.data.appointmentMode)
            return;
        this.setData({
            appointmentMode,
            date: appointmentMode === "soon" ? (0, booking_1.shanghaiDate)() : (0, booking_1.shanghaiDate)(1),
            selected: -1,
            selectedSlotLabel: "",
            quoteDetails: null,
            error: "",
        });
        await this.loadSlots();
    },
    quantityNotice() {
        wx.showToast({
            title: "当前每笔预约仅支持 1 项服务",
            icon: "none",
        });
    },
    select(e) {
        var _a, _b;
        if (!this.data.reservationId) {
            const selected = Number(e.currentTarget.dataset.index);
            this.setData({
                selected,
                selectedSlotLabel: (_b = (_a = this.data.slots[selected]) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : "",
                quoteDetails: null,
                error: "",
            });
        }
    },
    input(e) {
        const field = e.currentTarget.dataset.field;
        if (["contactName", "phone", "detail", "doorNumber"].includes(field) &&
            !this.data.orderSubmissionAttempted)
            this.setData({
                [field]: e.detail.value,
                ...(["detail", "doorNumber"].includes(field)
                    ? {
                        suggestions: [],
                        addressVerificationId: "",
                        quoteDetails: null,
                        ...(field === "detail"
                            ? { latitude: null, longitude: null }
                            : {}),
                    }
                    : {}),
            });
    },
    async locateAddress() {
        if (this.data.locationBusy || this.data.orderSubmissionAttempted)
            return;
        this.setData({ locationBusy: true, error: "", suggestions: [] });
        try {
            const point = await (0, amap_1.getGcj02Location)();
            const address = await (0, amap_1.reverseGeocode)(this.data.amapMiniappKey, point);
            this.setData({
                detail: address.detail.slice(0, 140),
                latitude: point.latitude,
                longitude: point.longitude,
                coordinateSystem: "GCJ-02",
                addressVerificationId: "",
                quoteDetails: null,
            });
            wx.showToast({ title: "已定位并转为中文地址", icon: "success" });
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ locationBusy: false });
        }
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
            const suggestions = await (0, amap_1.suggestAddress)(this.data.amapMiniappKey, keyword, this.data.serviceCity);
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
            .slice(0, 140);
        this.setData({
            detail,
            latitude: suggestion.latitude,
            longitude: suggestion.longitude,
            coordinateSystem: "GCJ-02",
            suggestions: [],
            addressVerificationId: "",
            quoteDetails: null,
        });
    },
    consentChanged(e) {
        this.setData({ consent: e.detail.value.includes("agree") });
    },
    fullAddress() {
        return `${this.data.detail.trim()} ${this.data.doorNumber.trim()}`.trim();
    },
    async ensureAddressCoordinates() {
        if (this.data.latitude !== null && this.data.longitude !== null)
            return {
                latitude: this.data.latitude,
                longitude: this.data.longitude,
                coordinateSystem: "GCJ-02",
            };
        const geocoded = await (0, api_1.api)("/locations/address-geocodes", "POST", { detail: this.data.detail.trim() });
        this.setData({
            latitude: geocoded.latitude,
            longitude: geocoded.longitude,
            coordinateSystem: "GCJ-02",
            addressVerificationId: "",
            quoteDetails: null,
        });
        wx.showToast({ title: "手填地址已用高德识别", icon: "success" });
        return geocoded;
    },
    validDraft() {
        const slot = this.data.slots[this.data.selected];
        const service = this.data.service;
        if (!service ||
            !slot ||
            !this.data.consent ||
            this.data.contactName.trim().length < 2 ||
            !/^1\d{10}$/.test(this.data.phone) ||
            this.data.detail.trim().length < 5) {
            this.fail(new Error("请选择时段，填写有效地址与手机号码，并确认服务边界"));
            return null;
        }
        return { service, slot };
    },
    async prepareOrder() {
        if (this.data.busy)
            return;
        const draft = this.validDraft();
        if (!draft)
            return;
        const { service, slot } = draft;
        this.setData({ busy: true, error: "" });
        try {
            let session = (0, auth_1.getStoredSession)();
            if (!session) {
                session = await (0, auth_1.loginWithWechat)();
                this.setData({
                    loggedIn: true,
                    phoneVerified: session.user.phoneVerified === true,
                    loginError: "",
                });
            }
            if ((0, auth_1.needsPhoneVerification)(session)) {
                (0, auth_1.goToPhoneVerification)();
                return;
            }
            const addressPoint = await this.ensureAddressCoordinates();
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
                    detail: this.fullAddress(),
                    latitude: addressPoint.latitude,
                    longitude: addressPoint.longitude,
                    coordinateSystem: "GCJ-02",
                });
                this.setData({ addressVerificationId: verification.id });
            }
            const quote = await (0, api_1.api)("/orders/quote", "POST", {
                reservationId: this.data.reservationId,
            });
            this.setData({ quoteDetails: (0, booking_1.quoteDisplay)(quote) });
            wx.showToast({ title: "价格已由服务器核定", icon: "success" });
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async create() {
        if (this.data.busy)
            return;
        if (!this.data.quoteDetails) {
            await this.prepareOrder();
            return;
        }
        if (!this.validDraft() || !this.data.reservationId)
            return;
        this.setData({ busy: true, error: "" });
        try {
            let session = (0, auth_1.getStoredSession)();
            if (!session) {
                session = await (0, auth_1.loginWithWechat)();
                this.setData({
                    loggedIn: true,
                    phoneVerified: session.user.phoneVerified === true,
                    loginError: "",
                });
            }
            if ((0, auth_1.needsPhoneVerification)(session)) {
                (0, auth_1.goToPhoneVerification)();
                return;
            }
            // Once an order request leaves the device, keep the request immutable so
            // an uncertain network result can be retried with the same fingerprint.
            this.setData({ orderSubmissionAttempted: true });
            const order = await (0, api_1.api)("/orders", "POST", {
                reservationId: this.data.reservationId,
                address: {
                    contactName: this.data.contactName.trim(),
                    phone: this.data.phone,
                    detail: this.fullAddress(),
                    latitude: this.data.latitude,
                    longitude: this.data.longitude,
                    coordinateSystem: "GCJ-02",
                },
                ...(this.data.addressVerificationId
                    ? { addressVerificationId: this.data.addressVerificationId }
                    : {}),
            }, this.data.orderKey);
            this.setData({
                reservationId: "",
                orderKey: "",
                addressVerificationId: "",
                quoteDetails: null,
                orderSubmissionAttempted: false,
            });
            await this.payCreatedOrder(order);
            wx.switchTab({ url: "/pages/orders/index" });
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ busy: false });
        }
    },
    async payCreatedOrder(order) {
        if (order.status !== "PENDING_PAYMENT")
            return;
        let intent;
        try {
            intent = await (0, api_1.api)(`/orders/${order.id}/payment-intent`, "POST", {});
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "微信支付暂时无法发起";
            wx.showModal({
                title: "订单已创建",
                content: `${message}。订单已安全保存，可在“订单”页继续支付。`,
                confirmText: "查看订单",
                showCancel: false,
            });
            return;
        }
        if (!intent ||
            typeof intent.id !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id) ||
            intent.orderId !== order.id ||
            !Number.isSafeInteger(intent.amountFen) ||
            intent.amountFen <= 0 ||
            intent.amountFen !== order.payableFen) {
            wx.showModal({
                title: "订单已创建",
                content: "支付订单或金额核验失败。请在订单页刷新后重试，切勿重复下单。",
                confirmText: "查看订单",
                showCancel: false,
            });
            return;
        }
        if (intent.provider !== "WECHAT") {
            wx.showToast({ title: "订单已创建，请在订单页继续支付", icon: "none" });
            return;
        }
        if (intent.status !== "PENDING" ||
            intent.prepayState !== "READY" ||
            !intent.wechatPayParameters) {
            try {
                const result = await (0, api_1.api)(`/payments/${intent.id}/reconcile`, "POST", {});
                if (result.status === "SUCCEEDED") {
                    wx.showToast({ title: "支付已确认", icon: "success" });
                    return;
                }
            }
            catch {
                /* The order page remains the only safe retry surface. */
            }
            wx.showModal({
                title: "订单已创建",
                content: "微信预下单结果待确认。请在订单页刷新或查询原单，切勿重复下单。",
                confirmText: "查看订单",
                showCancel: false,
            });
            return;
        }
        const confirmed = await new Promise((resolve) => wx.showModal({
            title: "确认微信支付",
            content: `本次预约应付 ¥${(0, api_1.money)(intent.amountFen)}，确认后将打开微信支付。最终结果以微信支付通知和原单查询为准。`,
            confirmText: "去支付",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
        }));
        if (!confirmed) {
            wx.showToast({ title: "订单已保留，可稍后继续支付", icon: "none" });
            return;
        }
        const sdkResult = await new Promise((resolve) => wx.requestPayment({
            ...intent.wechatPayParameters,
            success: () => resolve("success"),
            fail: (error) => resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
        }));
        try {
            const result = await (0, api_1.api)(`/payments/${intent.id}/reconcile`, "POST", {});
            if (result.status === "SUCCEEDED") {
                wx.showToast({ title: "支付成功，预约已生效", icon: "success" });
                return;
            }
        }
        catch {
            /* Notification/query may arrive after the native SDK returns. */
        }
        if (sdkResult === "cancel") {
            wx.showToast({ title: "已取消支付，订单仍为待付款", icon: "none" });
            return;
        }
        wx.showToast({ title: "支付结果确认中，请在订单页刷新", icon: "none" });
    },
    onUnload() {
        this.setData({
            contactName: "",
            phone: "",
            detail: "",
            doorNumber: "",
            latitude: null,
            longitude: null,
            suggestions: [],
            addressVerificationId: "",
            quoteDetails: null,
            orderSubmissionAttempted: false,
        });
    },
});

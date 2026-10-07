"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../utils/auth");
const api_1 = require("../../utils/api");
const customer_service_1 = require("../../utils/customer-service");
const tab_bar_1 = require("../../utils/tab-bar");
// These are public merchant contact channels, not credentials. Keeping a
// compile-time fallback makes emergency/contact access survive API maintenance.
// A successful public-config response remains authoritative and replaces them.
const PUBLIC_CONTACT_FALLBACK = {
    customerService: {
        provider: "wecom",
        available: true,
        corpId: "ww715e0d876d9f3cb4",
        url: "https://work.weixin.qq.com/kfid/kfca6852bf5e57656af",
    },
    emergencyContact: {
        configured: true,
        phone: "18018181799",
    },
};
Page({
    data: {
        loggedIn: false,
        phoneVerified: false,
        displayName: "微信用户",
        stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
        customerService: PUBLIC_CONTACT_FALLBACK.customerService,
        emergencyContact: PUBLIC_CONTACT_FALLBACK.emergencyContact,
    },
    onLoad() {
        const session = (0, auth_1.getStoredSession)();
        if (session)
            this.setData({
                loggedIn: true,
                phoneVerified: session.user.phoneVerified === true,
                displayName: session.user.displayName,
            });
    },
    async onShow() {
        var _a;
        (0, tab_bar_1.syncCustomTabBar)(this, 4);
        const session = (0, auth_1.getStoredSession)();
        this.setData({
            loggedIn: Boolean(session),
            phoneVerified: (session === null || session === void 0 ? void 0 : session.user.phoneVerified) === true,
            displayName: (_a = session === null || session === void 0 ? void 0 : session.user.displayName) !== null && _a !== void 0 ? _a : "微信用户",
        });
        // Public, compile-time safety channels remain available during API maintenance.
        // Any successful server response is authoritative and replaces this fallback.
        this.setData({
            customerService: PUBLIC_CONTACT_FALLBACK.customerService,
            emergencyContact: PUBLIC_CONTACT_FALLBACK.emergencyContact,
        });
        try {
            const config = await (0, api_1.api)("/config/public");
            this.setData({
                customerService: config.customerService,
                emergencyContact: config.emergencyContact,
            });
        }
        catch {
            /* Unconfigured/unreachable is shown explicitly by the tap handler. */
        }
        if (session)
            await this.loadStats();
    },
    async loadStats() {
        try {
            const orders = await (0, api_1.api)("/orders");
            this.setData({
                stats: {
                    upcoming: orders.filter((order) => ["PAID", "DISPATCHING", "ASSIGNED", "EN_ROUTE", "ARRIVED"].includes(order.status)).length,
                    active: orders.filter((order) => order.status === "IN_SERVICE")
                        .length,
                    confirmation: orders.filter((order) => order.status === "AWAITING_CONFIRMATION").length,
                    afterSale: orders.filter((order) => ["REFUNDING", "REFUNDED"].includes(order.status)).length,
                },
            });
        }
        catch {
            this.setData({
                stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
            });
        }
    },
    openCustomerService() {
        (0, customer_service_1.openWecomCustomerService)(this.data.customerService);
    },
    callEmergency() {
        (0, customer_service_1.callEmergencyDuty)(this.data.emergencyContact);
    },
    openLogin() {
        (0, auth_1.goToPhoneVerification)();
    },
    verifyPhone() {
        (0, auth_1.goToPhoneVerification)();
    },
    openAdminLogin() {
        wx.navigateTo({ url: "/pages/admin-login/index" });
    },
    openMfaRecovery() {
        wx.navigateTo({ url: "/pages/mfa-recovery/index" });
    },
    async logout() {
        try {
            await (0, api_1.api)("/auth/logout", "POST", {});
        }
        catch {
            wx.showToast({ title: "服务端注销未确认，请稍后重试", icon: "none" });
            return;
        }
        (0, auth_1.clearStoredSession)();
        this.setData({
            loggedIn: false,
            phoneVerified: false,
            displayName: "微信用户",
            stats: { upcoming: 0, active: 0, confirmation: 0, afterSale: 0 },
        });
        wx.showToast({ title: "会话已安全注销", icon: "success" });
    },
});

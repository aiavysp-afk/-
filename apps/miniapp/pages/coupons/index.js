"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const customer_center_1 = require("../../utils/customer-center");
const auth_1 = require("../../utils/auth");
const statusLabels = {
    AVAILABLE: "可使用",
    USED: "已使用",
    EXPIRED: "已过期",
};
Page({
    data: {
        tabs: [
            { key: "AVAILABLE", label: "可用优惠券" },
            { key: "USED", label: "已使用" },
            { key: "EXPIRED", label: "已过期" },
        ],
        activeStatus: "AVAILABLE",
        coupons: [],
        loading: false,
        error: "",
        newcomer: null,
        newcomerBusy: false,
        newcomerError: "",
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        await Promise.all([this.load(), this.loadNewcomer()]);
    },
    async loadNewcomer() {
        try {
            const newcomer = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/newcomer-coupons"));
            this.setData({ newcomer, newcomerError: "" });
        }
        catch (error) {
            this.setData({
                newcomerError: error instanceof Error ? error.message : "新人优惠读取失败",
            });
        }
    },
    async claimNewcomer() {
        var _a;
        if (!(0, auth_1.requireVerifiedCustomerAccess)() || this.data.newcomerBusy)
            return;
        if ((_a = this.data.newcomer) === null || _a === void 0 ? void 0 : _a.claimed) {
            this.goUse();
            return;
        }
        if (!this.data.newcomer || this.data.newcomerError) {
            await this.loadNewcomer();
            return;
        }
        if (!this.data.newcomer.eligible)
            return;
        this.setData({ newcomerBusy: true, newcomerError: "" });
        try {
            const newcomer = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/newcomer-coupons"), "POST", {});
            this.setData({
                newcomer,
                activeStatus: "AVAILABLE",
            });
            if (newcomer.claimed) {
                wx.showToast({ title: "新人优惠券已领取", icon: "success" });
                await this.load();
            }
        }
        catch (error) {
            this.setData({
                newcomerError: error instanceof Error ? error.message : "领取失败，请重试",
            });
        }
        finally {
            this.setData({ newcomerBusy: false });
        }
    },
    async load() {
        this.setData({ loading: true, error: "" });
        try {
            const coupons = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/coupons", {
                status: this.data.activeStatus,
            }));
            this.setData({
                coupons: coupons.map((coupon) => ({
                    ...coupon,
                    amount: (0, api_1.money)(coupon.amountFen),
                    threshold: coupon.minimumSpendFen > 0
                        ? `项目费满 ¥${(0, api_1.money)(coupon.minimumSpendFen)} 可用`
                        : "无使用门槛",
                    validity: `${coupon.validFrom.slice(0, 10)} 至 ${coupon.expiresAt.slice(0, 10)}`,
                    statusLabel: statusLabels[coupon.status],
                })),
            });
        }
        catch (error) {
            this.setData({
                coupons: [],
                error: error instanceof Error ? error.message : "优惠券读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    changeStatus(event) {
        const activeStatus = event.currentTarget.dataset.status;
        if (activeStatus === this.data.activeStatus)
            return;
        this.setData({ activeStatus });
        void this.load();
    },
    showUsageHistory() {
        this.setData({ activeStatus: "USED" });
        void this.load();
    },
    goUse() {
        wx.switchTab({ url: "/pages/services/index" });
    },
});

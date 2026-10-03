"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
Page({
    data: {
        orders: [],
        loading: false,
        busy: "",
        error: "",
        loggedIn: false,
    },
    async onShow() {
        await this.load();
    },
    async login() {
        try {
            await (0, auth_1.loginWithWechat)();
            await this.load();
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
    async load() {
        const loggedIn = !!(0, auth_1.getStoredSession)();
        this.setData({ loggedIn, loading: loggedIn, error: "", orders: [] });
        if (!loggedIn)
            return;
        try {
            const orders = await (0, api_1.api)("/orders");
            const rows = await Promise.all(orders.map(async (order) => {
                const refunds = await (0, api_1.api)(`/orders/${order.id}/refunds`);
                return {
                    ...order,
                    price: (0, api_1.money)(order.payableFen),
                    time: (0, api_1.shanghaiTime)(order.appointmentStart),
                    refunds,
                    refundAvailable: [
                        "PAID",
                        "DISPATCHING",
                        "ASSIGNED",
                        "EN_ROUTE",
                        "ARRIVED",
                    ].includes(order.status) &&
                        !refunds.some((row) => row.status !== "REJECTED"),
                };
            }));
            this.setData({ orders: rows });
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async action(e) {
        if (this.data.busy)
            return;
        const { id, action } = e.currentTarget.dataset;
        this.setData({ busy: id, error: "" });
        try {
            if (action === "pay") {
                const intent = await (0, api_1.api)(`/orders/${id}/payment-intent`, "POST", {});
                if (intent.provider === "WECHAT") {
                    if (intent.status !== "PENDING" || !intent.wechatPayParameters) {
                        try {
                            const result = await (0, api_1.api)(`/payments/${intent.id}/reconcile`, "POST", {});
                            if (result.status === "SUCCEEDED") {
                                await this.load();
                                return;
                            }
                        }
                        catch {
                            /* An unconfirmed result must never trigger a new payment POST or local success. */
                        }
                        await this.load();
                        throw new Error("预下单结果未确认，请刷新订单或查询原单，不要重复新建支付");
                    }
                    const sdkResult = await new Promise((resolve) => wx.requestPayment({
                        ...intent.wechatPayParameters,
                        success: () => resolve("success"),
                        fail: (error) => resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
                    }));
                    // SDK success is not settlement proof; only verified server query/notification changes the order.
                    if (sdkResult !== "cancel") {
                        try {
                            await (0, api_1.api)(`/payments/${intent.id}/reconcile`, "POST", {});
                        }
                        catch {
                            wx.showToast({
                                title: "支付结果待确认，请刷新订单",
                                icon: "none",
                            });
                        }
                    }
                    if (sdkResult === "cancel")
                        wx.showToast({ title: "已取消支付，订单尚未取消", icon: "none" });
                    if (sdkResult === "failure")
                        wx.showToast({ title: "支付结果待确认，请刷新订单", icon: "none" });
                }
                else {
                    if (!intent.mockConfirmationAvailable)
                        throw new Error("当前订单不能模拟支付");
                    const confirmed = await new Promise((resolve) => wx.showModal({
                        title: "仅本地模拟支付",
                        content: "不会扣除微信零钱或银行卡余额。是否标记此测试订单模拟支付成功？",
                        success: (result) => resolve(result.confirm),
                        fail: () => resolve(false),
                    }));
                    if (confirmed)
                        await (0, api_1.api)(`/dev/payments/${intent.id}/succeed`, "POST", {});
                }
            }
            else if (action === "cancel")
                await (0, api_1.api)(`/orders/${id}/cancel`, "POST", {});
            else if (action === "refund") {
                const storageKey = `zydj.refund.key.${id}`;
                const key = wx.getStorageSync(storageKey) || (0, api_1.newKey)();
                wx.setStorageSync(storageKey, key);
                await (0, api_1.api)(`/orders/${id}/refunds`, "POST", {}, String(key));
                wx.removeStorageSync(storageKey);
            }
            await this.load();
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.setData({ busy: "" });
        }
    },
});

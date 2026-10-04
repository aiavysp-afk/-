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
        showEmptyOrders: false,
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
        this.setData({
            loggedIn,
            loading: loggedIn,
            error: "",
            orders: [],
            showEmptyOrders: false,
        });
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
            this.setData({
                loading: false,
                showEmptyOrders: loggedIn && !this.data.error && this.data.orders.length === 0,
            });
        }
    },
    async action(e) {
        if (this.data.busy)
            return;
        const { id, action } = e.currentTarget.dataset;
        this.setData({ busy: id, error: "" });
        try {
            if (action === "pay") {
                const order = this.data.orders.find((row) => row.id === id);
                if (!order || order.status !== "PENDING_PAYMENT")
                    throw new Error("请刷新订单，确认仍待支付后再操作");
                const intent = await (0, api_1.api)(`/orders/${id}/payment-intent`, "POST", {});
                if (!intent ||
                    typeof intent.id !== "string" ||
                    !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id) ||
                    intent.orderId !== id ||
                    !Number.isSafeInteger(intent.amountFen) ||
                    intent.amountFen <= 0 ||
                    intent.amountFen !== order.payableFen)
                    throw new Error("支付订单或金额不一致，请刷新订单并联系客服");
                if (intent.provider === "WECHAT") {
                    if (intent.status !== "PENDING" ||
                        intent.prepayState !== "READY" ||
                        !intent.wechatPayParameters) {
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
                    const confirmed = await new Promise((resolve) => wx.showModal({
                        title: "确认微信真实支付",
                        content: `订单金额 ¥${(0, api_1.money)(intent.amountFen)}。这是微信真实付款，不是模拟支付；最终付款以微信确认页为准。取消不会调起微信支付，也不会取消订单。`,
                        success: (result) => resolve(result.confirm === true),
                        fail: () => resolve(false),
                    }));
                    if (!confirmed) {
                        await this.load();
                        return;
                    }
                    const sdkResult = await new Promise((resolve) => wx.requestPayment({
                        ...intent.wechatPayParameters,
                        success: () => resolve("success"),
                        fail: (error) => resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
                    }));
                    // SDK success is not settlement proof; only verified server query/notification changes the order.
                    {
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
                else if (intent.provider === "MOCK") {
                    if (intent.status !== "PENDING" ||
                        intent.mockConfirmationAvailable !== true)
                        throw new Error("当前订单不能模拟支付");
                    const confirmed = await new Promise((resolve) => wx.showModal({
                        title: "仅本地模拟支付",
                        content: "不会扣除微信零钱或银行卡余额。是否标记此测试订单模拟支付成功？",
                        success: (result) => resolve(result.confirm === true),
                        fail: () => resolve(false),
                    }));
                    if (confirmed)
                        await (0, api_1.api)(`/dev/payments/${intent.id}/succeed`, "POST", {});
                }
                else {
                    throw new Error("支付渠道未识别，请刷新订单并联系客服");
                }
            }
            else if (action === "cancel") {
                const result = await (0, api_1.api)(`/payments/orders/${id}/close`, "POST", {});
                if (result.pendingConfirmation)
                    wx.showToast({
                        title: result.reviewRequired
                            ? "原单需人工核实，预约暂保留"
                            : "取消结果待查，预约暂保留",
                        icon: "none",
                    });
            }
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

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const customer_center_1 = require("../../utils/customer-center");
const tab_bar_1 = require("../../utils/tab-bar");
const statusLabels = {
    PENDING_PAYMENT: "待付款",
    PAID: "待技师接单",
    DISPATCHING: "派单中",
    ASSIGNED: "技师已接单",
    EN_ROUTE: "技师出发",
    ARRIVED: "技师到达",
    IN_SERVICE: "服务中",
    AWAITING_CONFIRMATION: "待确认完成",
    COMPLETED: "已完成",
    CANCELLED: "已取消",
    REFUNDING: "退款处理中",
    REFUNDED: "已退款",
};
Page({
    data: {
        categories: [
            { key: "ORDER", label: "订单服务", icon: "▤", tone: "mint" },
            { key: "ACTIVITY", label: "活动通知", icon: "旗", tone: "peach" },
            { key: "SYSTEM", label: "系统通知", icon: "◉", tone: "lime" },
            { key: "SERVICE", label: "在线客服", icon: "•••", tone: "blue" },
        ],
        activeType: "ORDER",
        messages: [],
        systemTitle: "系统通知",
        systemContent: "暂无系统通知",
        loading: false,
        error: "",
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        (0, tab_bar_1.syncCustomTabBar)(this, 3);
        await this.loadOrders();
    },
    async loadOrders() {
        this.setData({ loading: true, error: "" });
        try {
            const orders = await (0, api_1.api)("/orders");
            this.setData({
                messages: orders.slice(0, 20).map((order) => ({
                    id: order.id,
                    title: `${order.serviceName} · ${statusLabels[order.status]}`,
                    detail: `订单 ${order.orderNo} · 预约 ${(0, api_1.shanghaiTime)(order.appointmentStart)}`,
                    time: (0, api_1.shanghaiTime)(order.createdAt),
                    statusLabel: statusLabels[order.status],
                })),
            });
        }
        catch (error) {
            this.setData({
                messages: [],
                error: error instanceof Error ? error.message : "订单消息读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async selectCategory(event) {
        const activeType = event.currentTarget.dataset.key;
        this.setData({ activeType, error: "" });
        if (activeType === "ORDER")
            await this.loadOrders();
        if (activeType === "SYSTEM")
            await this.loadSystem();
    },
    async loadSystem() {
        this.setData({ loading: true });
        try {
            const overview = await (0, customer_center_1.loadCustomerCenterOverview)();
            this.setData({
                systemTitle: overview.content.cityNewsTitle,
                systemContent: overview.content.cityNewsContent,
            });
        }
        catch (error) {
            this.setData({
                error: error instanceof Error ? error.message : "系统通知读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    openOrder() {
        wx.navigateTo({ url: "/pages/orders/index" });
    },
});

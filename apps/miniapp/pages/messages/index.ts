import type { OrderStatus, OrderView, PaymentNotification } from "@zydj/contracts";
import { api, shanghaiTime } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";
import { loadCustomerCenterOverview } from "../../utils/customer-center";
import { syncCustomTabBar } from "../../utils/tab-bar";

type MessageType = "ORDER" | "ACTIVITY" | "SYSTEM" | "SERVICE";
type OrderMessage = {
  id: string;
  title: string;
  detail: string;
  time: string;
  statusLabel: string;
};

const statusLabels: Record<OrderStatus, string> = {
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
    activeType: "ORDER" as MessageType,
    messages: [] as OrderMessage[],
    systemTitle: "系统通知",
    systemContent: "暂无系统通知",
    loading: false,
    error: "",
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    syncCustomTabBar(this, 3);
    await this.loadOrders();
  },
  async loadOrders() {
    this.setData({ loading: true, error: "" });
    try {
      const [orders, notifications] = await Promise.all([
        api<OrderView[]>("/orders"),
        api<PaymentNotification[]>("/payments/notifications"),
      ]);
      this.setData({
        // These payment notices are durable, owner-only server events, not
        // native SDK success or fabricated WeChat subscription pushes.
        messages: [
          ...notifications.map((notification) => ({
            id: notification.id,
            title: notification.title,
            detail: notification.body,
            time: shanghaiTime(notification.createdAt),
            statusLabel: "好友代付通知",
          })),
          ...orders.slice(0, 20).map((order) => ({
          id: order.id,
          title: `${order.serviceName} · ${statusLabels[order.status]}`,
          detail: `订单 ${order.orderNo} · 预约 ${shanghaiTime(
            order.appointmentStart,
          )}`,
          time: shanghaiTime(order.createdAt),
          statusLabel: statusLabels[order.status],
          })),
        ].sort((left, right) => right.time.localeCompare(left.time)).slice(0, 40),
      });
    } catch (error) {
      this.setData({
        messages: [],
        error: error instanceof Error ? error.message : "订单消息读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  async selectCategory(event: {
    currentTarget: { dataset: { key: MessageType } };
  }) {
    const activeType = event.currentTarget.dataset.key;
    this.setData({ activeType, error: "" });
    if (activeType === "ORDER") await this.loadOrders();
    if (activeType === "SYSTEM") await this.loadSystem();
  },
  async loadSystem() {
    this.setData({ loading: true });
    try {
      const overview = await loadCustomerCenterOverview();
      this.setData({
        systemTitle: overview.content.cityNewsTitle,
        systemContent: overview.content.cityNewsContent,
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "系统通知读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  openOrder() {
    wx.navigateTo({ url: "/pages/orders/index" });
  },
});

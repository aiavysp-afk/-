import type {
  TechnicianOnboarding,
  TechnicianWorkbench,
  TechnicianOrderAction,
  TechnicianOrderActionResult,
} from "@zydj/contracts";
import { api } from "../../utils/api";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

const actions: Record<
  string,
  { action: TechnicianOrderAction["action"]; label: string }
> = {
  PAID: { action: "ACCEPT", label: "确认接单" },
  DISPATCHING: { action: "ACCEPT", label: "确认接单" },
  ASSIGNED: { action: "DEPART", label: "出发上门" },
  EN_ROUTE: { action: "ARRIVE", label: "确认到达" },
  ARRIVED: { action: "START_SERVICE", label: "开始服务" },
  IN_SERVICE: { action: "FINISH_SERVICE", label: "完成服务" },
};
const statusLabels: Record<string, string> = {
  PAID: "已支付",
  DISPATCHING: "待接单",
  ASSIGNED: "已指派",
  EN_ROUTE: "上门途中",
  ARRIVED: "已到达",
  IN_SERVICE: "服务中",
  AWAITING_CONFIRMATION: "待客户确认",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUNDED: "已退款",
};
const paymentLabels: Record<string, string> = {
  SUCCEEDED: "已支付",
  PENDING: "待支付",
  FAILED: "支付失败",
  CLOSED: "已关闭",
  REFUNDED: "已退款",
};
function shanghaiTime(value: string) {
  const date = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) return "时间待确认";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
Page({
  data: {
    busy: false,
    acting: false,
    error: "",
    workbench: null as TechnicianWorkbench | null,
    orders: [] as object[],
    shifts: [] as object[],
    notifications: null as { enabled: boolean; templateId: string | null; message: string } | null,
    subscribing: false,
    subscriptionNotice: "",
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess("/pages/technician-workbench/index"))
      return;
    await this.load();
  },
  async load() {
    if (this.data.busy || this.data.acting) return;
    this.setData({
      busy: true,
      error: "",
      workbench: null,
      orders: [],
      shifts: [],
    });
    try {
      const access = await api<TechnicianOnboarding>("/technician/onboarding");
      if (!access.canEnterWorkbench) {
        wx.redirectTo({ url: "/pages/technician-onboarding/index" });
        return;
      }
      const workbench = await api<TechnicianWorkbench>("/technician/workbench");
      const notifications = await api<{ enabled: boolean; templateId: string | null; message: string }>("/technician/workbench/notifications")
        .catch(() => ({ enabled: false, templateId: null, message: "微信提醒配置暂时不可读取，请在工作台查看订单。" }));
      this.setData({
        workbench,
        notifications,
        orders: workbench.orders.map((row) => ({
          ...row,
          next: actions[row.status],
          time: shanghaiTime(row.appointmentStart),
          statusLabel: statusLabels[row.status] ?? row.status,
          paymentLabel: row.payment
            ? (paymentLabels[row.payment.status] ?? "支付状态待确认")
            : "",
        })),
        shifts: workbench.shifts.map((row) => ({
          ...row,
          startsLabel: shanghaiTime(row.startsAt),
          endsLabel: shanghaiTime(row.endsAt),
        })),
      });
    } catch (error) {
      this.setData({
        error: error instanceof Error ? error.message : "工作台读取失败",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  async advance(event: {
    currentTarget: {
      dataset: { id: string; action: TechnicianOrderAction["action"] };
    };
  }) {
    if (this.data.acting || !this.data.workbench) return;
    const { id, action } = event.currentTarget.dataset;
    const order = this.data.workbench.orders.find((row) => row.id === id);
    if (!order || actions[order.status]?.action !== action) return;
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: actions[order.status]!.label,
        content: "确认本人的实际服务进度。状态将同步客户和后台。",
        success: (value) => resolve(value.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    this.setData({ acting: true, error: "" });
    try {
      await api<TechnicianOrderActionResult>(
        `/technician/workbench/orders/${encodeURIComponent(id)}/actions`,
        "POST",
        { action },
      );
    } catch (error) {
      this.setData({
        error:
          error instanceof Error ? error.message : "操作失败，请刷新后重试",
      });
      return;
    } finally {
      this.setData({ acting: false });
    }
    await this.load();
  },
  editProfile() {
    wx.navigateTo({ url: "/pages/technician-photos/index" });
  },
  subscribeOrders() {
    const config = this.data.notifications;
    if (this.data.subscribing || !config?.enabled || !config.templateId) return;
    // Invoke directly from the tap event; no automatic permission prompts.
    this.setData({ subscribing: true, subscriptionNotice: "" });
    const requestId = `subscription-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    wx.requestSubscribeMessage({
      tmplIds: [config.templateId],
      success: result => {
        if (result[config.templateId!] !== "accept") {
          this.setData({ subscribing: false, subscriptionNotice: "您未同意订阅，可以继续在工作台查看订单。" });
          return;
        }
        api("/technician/workbench/notifications/subscribe", "POST", {
          requestId, templateId: config.templateId, accepted: true,
        }).then(() => this.setData({ subscriptionNotice: "已登记本次订阅，下一笔符合条件的新订单将尝试通过微信提醒。" }))
          .catch(() => this.setData({ subscriptionNotice: "订阅登记未确认，请继续在工作台查看订单，稍后再试。" }))
          .finally(() => this.setData({ subscribing: false }));
      },
      fail: () => this.setData({ subscribing: false, subscriptionNotice: "微信订阅未完成，请稍后手动重试。" }),
    });
  },
});

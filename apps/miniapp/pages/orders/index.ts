import type {
  CustomerOrderConfirmationResult,
  CustomerTechnicianLocation,
  OrderView,
  PaymentIntent,
  RefundView,
  SafetyIncidentCreate,
  SafetyIncidentCustomerView,
} from "@zydj/contracts";
import { api, money, newKey, shanghaiTime } from "../../utils/api";
import { getStoredSession, loginWithWechat } from "../../utils/auth";
import { syncCustomTabBar } from "../../utils/tab-bar";
type Row = OrderView & {
  price: string;
  time: string;
  refunds: RefundView[];
  refundAvailable: boolean;
  safetyIncidents: Array<SafetyIncidentCustomerView & { statusLabel: string }>;
  safetyAvailable: boolean;
  confirmAvailable: boolean;
  technicianLocation: CustomerTechnicianLocation;
  technicianLocationLabel: string;
  technicianLocationAvailable: boolean;
};
const safetyCategories: Array<{
  label: string;
  value: SafetyIncidentCreate["category"];
}> = [
  { label: "人身安全风险", value: "PERSONAL_SAFETY" },
  { label: "身体不适或医疗顾虑", value: "MEDICAL_CONCERN" },
  { label: "服务争议需立即介入", value: "SERVICE_DISPUTE" },
  { label: "其他紧急情况", value: "OTHER_URGENT" },
];
const safetyStatuses: Record<string, string> = {
  OPEN: "等待主岗确认",
  ESCALATED: "主岗超时，已转备岗",
  ACKNOWLEDGED: "值班人员已确认",
  CLOSED: "已关闭并留痕",
};
const technicianLocationStatuses: Record<string, string> = {
  UNASSIGNED: "尚未指派技师",
  HIDDEN: "技师出发后可查看位置状态",
  UNAVAILABLE: "技师尚未上报位置",
  STALE: "技师位置已超过 5 分钟未更新",
  AVAILABLE: "技师位置已更新",
};
Page({
  data: {
    orders: [] as Row[],
    loading: false,
    busy: "",
    error: "",
    loggedIn: false,
    showEmptyOrders: false,
  },
  async onShow() {
    syncCustomTabBar(this, 3);
    await this.load();
  },
  async login() {
    try {
      await loginWithWechat();
      await this.load();
    } catch (error) {
      this.fail(error);
    }
  },
  fail(error: unknown) {
    this.setData({
      error: error instanceof Error ? error.message : "请求失败",
    });
  },
  async load() {
    const loggedIn = !!getStoredSession();
    this.setData({
      loggedIn,
      loading: loggedIn,
      error: "",
      orders: [],
      showEmptyOrders: false,
    });
    if (!loggedIn) return;
    try {
      const orders = await api<OrderView[]>("/orders");
      const rows = await Promise.all(
        orders.map(async (order) => {
          const [refunds, safetyIncidents, technicianLocation] =
            await Promise.all([
              api<RefundView[]>(`/orders/${order.id}/refunds`),
              api<SafetyIncidentCustomerView[]>(
                `/orders/${order.id}/safety-incidents`,
              ),
              api<CustomerTechnicianLocation>(
                `/orders/${order.id}/technician-location`,
              ).catch(() => ({
                orderId: order.id,
                status: "UNAVAILABLE" as const,
                location: null,
              })),
            ]);
          return {
            ...order,
            price: money(order.payableFen),
            time: shanghaiTime(order.appointmentStart),
            refunds,
            safetyIncidents: safetyIncidents.map((incident) => ({
              ...incident,
              statusLabel: safetyStatuses[incident.status] ?? "状态待确认",
            })),
            refundAvailable:
              [
                "PAID",
                "DISPATCHING",
                "ASSIGNED",
                "EN_ROUTE",
                "ARRIVED",
              ].includes(order.status) &&
              !refunds.some((row) => row.status !== "REJECTED"),
            safetyAvailable:
              [
                "PAID",
                "DISPATCHING",
                "ASSIGNED",
                "EN_ROUTE",
                "ARRIVED",
                "IN_SERVICE",
                "AWAITING_CONFIRMATION",
              ].includes(order.status) &&
              !safetyIncidents.some((incident) => incident.status !== "CLOSED"),
            confirmAvailable: order.status === "AWAITING_CONFIRMATION",
            technicianLocation,
            technicianLocationLabel:
              technicianLocationStatuses[technicianLocation.status] ??
              "技师位置状态待更新",
            technicianLocationAvailable: Boolean(technicianLocation.location),
          };
        }),
      );
      this.setData({ orders: rows });
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({
        loading: false,
        showEmptyOrders:
          loggedIn && !this.data.error && this.data.orders.length === 0,
      });
    }
  },
  async action(e: {
    currentTarget: { dataset: { id: string; action: string } };
  }) {
    if (this.data.busy) return;
    const { id, action } = e.currentTarget.dataset;
    this.setData({ busy: id, error: "" });
    try {
      if (action === "pay") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        if (!order || order.status !== "PENDING_PAYMENT")
          throw new Error("请刷新订单，确认仍待支付后再操作");
        const intent = await api<PaymentIntent>(
          `/orders/${id}/payment-intent`,
          "POST",
          {},
        );
        if (
          !intent ||
          typeof intent.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id) ||
          intent.orderId !== id ||
          !Number.isSafeInteger(intent.amountFen) ||
          intent.amountFen <= 0 ||
          intent.amountFen !== order.payableFen
        )
          throw new Error("支付订单或金额不一致，请刷新订单并联系客服");
        if (intent.provider === "WECHAT") {
          if (
            intent.status !== "PENDING" ||
            intent.prepayState !== "READY" ||
            !intent.wechatPayParameters
          ) {
            try {
              const result = await api<{ status: string }>(
                `/payments/${intent.id}/reconcile`,
                "POST",
                {},
              );
              if (result.status === "SUCCEEDED") {
                await this.load();
                return;
              }
            } catch {
              /* An unconfirmed result must never trigger a new payment POST or local success. */
            }
            await this.load();
            throw new Error(
              "预下单结果未确认，请刷新订单或查询原单，不要重复新建支付",
            );
          }
          const confirmed = await new Promise<boolean>((resolve) =>
            wx.showModal({
              title: "确认微信真实支付",
              content: `订单金额 ¥${money(intent.amountFen)}。这是微信真实付款，不是模拟支付；最终付款以微信确认页为准。取消不会调起微信支付，也不会取消订单。`,
              success: (result) => resolve(result.confirm === true),
              fail: () => resolve(false),
            }),
          );
          if (!confirmed) {
            await this.load();
            return;
          }
          const sdkResult = await new Promise<"success" | "cancel" | "failure">(
            (resolve) =>
              wx.requestPayment({
                ...intent.wechatPayParameters!,
                success: () => resolve("success"),
                fail: (error) =>
                  resolve(
                    error.errMsg.includes("cancel") ? "cancel" : "failure",
                  ),
              }),
          );
          // SDK success is not settlement proof; only verified server query/notification changes the order.
          {
            try {
              await api(`/payments/${intent.id}/reconcile`, "POST", {});
            } catch {
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
        } else if (intent.provider === "MOCK") {
          if (
            intent.status !== "PENDING" ||
            intent.mockConfirmationAvailable !== true
          )
            throw new Error("当前订单不能模拟支付");
          const confirmed = await new Promise<boolean>((resolve) =>
            wx.showModal({
              title: "仅本地模拟支付",
              content:
                "不会扣除微信零钱或银行卡余额。是否标记此测试订单模拟支付成功？",
              success: (result) => resolve(result.confirm === true),
              fail: () => resolve(false),
            }),
          );
          if (confirmed)
            await api(`/dev/payments/${intent.id}/succeed`, "POST", {});
        } else {
          throw new Error("支付渠道未识别，请刷新订单并联系客服");
        }
      } else if (action === "cancel") {
        const result = await api<{
          pendingConfirmation: boolean;
          reviewRequired?: boolean;
        }>(`/payments/orders/${id}/close`, "POST", {});
        if (result.pendingConfirmation)
          wx.showToast({
            title: result.reviewRequired
              ? "原单需人工核实，预约暂保留"
              : "取消结果待查，预约暂保留",
            icon: "none",
          });
      } else if (action === "refund") {
        const storageKey = `zydj.refund.key.${id}`;
        const key = wx.getStorageSync(storageKey) || newKey();
        wx.setStorageSync(storageKey, key);
        await api(`/orders/${id}/refunds`, "POST", {}, String(key));
        wx.removeStorageSync(storageKey);
      } else if (action === "confirm-completion") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        if (!order?.confirmAvailable)
          throw new Error("请刷新订单，确认技师已提交服务完成");
        const confirmed = await new Promise<boolean>((resolve) =>
          wx.showModal({
            title: "确认服务已完成",
            content:
              "确认后订单将完成。若服务尚未完成或存在争议，请取消并先联系客服。",
            confirmText: "确认完成",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
          }),
        );
        if (!confirmed) return;
        await api<CustomerOrderConfirmationResult>(
          `/orders/${id}/confirm-completion`,
          "POST",
          {},
        );
        wx.showToast({ title: "服务已确认完成", icon: "success" });
      } else if (action === "safety") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        if (!order?.safetyAvailable)
          throw new Error("该订单已有待处理安全事件，请刷新查看状态");
        const selected = await new Promise<number | null>((resolve) =>
          wx.showActionSheet({
            itemList: safetyCategories.map((category) => category.label),
            success: (result) => resolve(result.tapIndex),
            fail: () => resolve(null),
          }),
        );
        if (selected === null || !safetyCategories[selected]) return;
        const category = safetyCategories[selected];
        const confirmed = await new Promise<boolean>((resolve) =>
          wx.showModal({
            title: "确认记录安全事件",
            content:
              "提交只会记录事件并进入值班队列，不代表人工已经接通。若有人身危险或医疗急症，请立即报警或呼叫急救。",
            confirmText: "确认记录",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
          }),
        );
        if (!confirmed) return;
        const storageKey = `zydj.safety.key.${id}.${category.value}`;
        const key = wx.getStorageSync(storageKey) || newKey();
        wx.setStorageSync(storageKey, key);
        await api(
          `/orders/${id}/safety-incidents`,
          "POST",
          { category: category.value },
          String(key),
        );
        wx.removeStorageSync(storageKey);
        await new Promise<void>((resolve) =>
          wx.showModal({
            title: "事件已记录",
            content:
              "请留在安全位置并同时联系人工值班；系统记录不等于通知送达。紧急危险请立即报警或呼叫急救。",
            showCancel: false,
            complete: () => resolve(),
          }),
        );
      } else if (action === "technician-location") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        const location = order?.technicianLocation.location;
        if (!location)
          throw new Error(order?.technicianLocationLabel ?? "技师位置暂不可用");
        wx.openLocation({
          latitude: location.latitude,
          longitude: location.longitude,
          name: "技师位置",
          address: order?.technicianLocationLabel,
          scale: 16,
        });
      }
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
});

import type {
  CustomerOrderConfirmationResult,
  CustomerTechnicianLocation,
  OrderView,
  PaymentIntent,
  FriendPaymentShare,
  RefundView,
  SafetyIncidentCreate,
  SafetyIncidentCustomerView,
  TechnicianReview,
  TechnicianReviewCreate,
} from "@zydj/contracts";
import { api, money, newKey, shanghaiTime } from "../../utils/api";
import {
  getStoredSession,
  goToPhoneVerification,
  loginWithWechat,
  needsPhoneVerification,
  requireVerifiedCustomerAccess,
} from "../../utils/auth";
import { assertFriendPaymentShare } from "../../utils/friend-payment";
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
  removable: boolean;
  reviewAvailable: boolean;
  reviewStatusLabel: string;
  statusLabel: string;
  progressVisible: boolean;
  progressDetail: string;
  progressSteps: Array<{ label: string; tone: "done" | "current" | "pending" }>;
  policyVisible: boolean;
};
type CustomerOrder = OrderView & {
  reviewStatus: "PENDING_REVIEW" | "PUBLISHED" | "HIDDEN" | null;
};
type OrderFilter =
  | "ALL"
  | "PENDING_PAYMENT"
  | "IN_PROGRESS"
  | "PENDING_REVIEW"
  | "CANCELLED";
const filterTitles: Record<OrderFilter, string> = {
  ALL: "全部订单",
  PENDING_PAYMENT: "待付款订单",
  IN_PROGRESS: "进行中订单",
  PENDING_REVIEW: "待评价订单",
  CANCELLED: "已取消订单",
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
const orderStatusLabels: Record<string, string> = {
  PENDING_PAYMENT: "待付款",
  PAID: "已付款",
  DISPATCHING: "等待技师接单",
  ASSIGNED: "技师已接单",
  EN_ROUTE: "技师已出发",
  ARRIVED: "技师已到达",
  IN_SERVICE: "服务进行中",
  AWAITING_CONFIRMATION: "等待确认完成",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUNDING: "退款处理中",
  REFUNDED: "已退款",
};
const progressStatuses = [
  "PAID",
  "ASSIGNED",
  "EN_ROUTE",
  "ARRIVED",
  "IN_SERVICE",
  "AWAITING_CONFIRMATION",
] as const;
const progressLabels = ["已付款", "已接单", "出发", "到达", "服务中", "待确认"];

function orderProgress(status: string) {
  const normalized = status === "DISPATCHING" ? "PAID" : status;
  const current = progressStatuses.indexOf(
    normalized as (typeof progressStatuses)[number],
  );
  const progressSteps = progressLabels.map((label, index) => ({
    label,
    tone:
      index < current
        ? ("done" as const)
        : index === current
          ? ("current" as const)
          : ("pending" as const),
  }));
  const detail: Record<string, string> = {
    PAID: "订单已付款，系统正在匹配真实可约技师",
    DISPATCHING: "订单已进入接单队列，状态每 5 秒自动更新",
    ASSIGNED: "技师已经接单，请留意出发提醒",
    EN_ROUTE: "技师正在前往服务地址，可查看位置状态",
    ARRIVED: "技师已到达，请核验订单与人员信息",
    IN_SERVICE: "服务正在进行，如有异常请立即联系在线客服",
    AWAITING_CONFIRMATION: "技师已结束服务，请核对后确认完成",
  };
  return {
    progressVisible: current >= 0,
    progressDetail: detail[status] ?? "订单状态持续同步中",
    progressSteps,
  };
}
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let ordersPageVisible = false;
let loadInFlight = false;

function stopOrderRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
}

Page({
  data: {
    orders: [] as Row[],
    loading: false,
    busy: "",
    error: "",
    loggedIn: false,
    phoneVerified: false,
    showEmptyOrders: false,
    reviewOpen: false,
    reviewOrderId: "",
    reviewRating: 5,
    reviewRatings: [1, 2, 3, 4, 5],
    reviewContent: "",
    orderFilter: "ALL" as OrderFilter,
    filterTitle: filterTitles.ALL,
  },
  onLoad(options: { status?: string }) {
    const requested = options.status as OrderFilter;
    const orderFilter = filterTitles[requested] ? requested : "ALL";
    this.setData({ orderFilter, filterTitle: filterTitles[orderFilter] });
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  async onShow() {
    ordersPageVisible = true;
    stopOrderRefresh();
    if (!requireVerifiedCustomerAccess()) return;
    await this.load();
    if (ordersPageVisible) {
      refreshTimer = setInterval(() => void this.load(true), 5_000);
    }
  },
  onHide() {
    ordersPageVisible = false;
    stopOrderRefresh();
  },
  onUnload() {
    ordersPageVisible = false;
    stopOrderRefresh();
  },
  async login() {
    try {
      const session = await loginWithWechat();
      if (needsPhoneVerification(session)) {
        this.setData({ loggedIn: true, phoneVerified: false });
        goToPhoneVerification();
        return;
      }
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
  async load(silent = false) {
    if (loadInFlight) return;
    loadInFlight = true;
    const session = getStoredSession();
    const loggedIn = Boolean(session);
    const phoneVerified = session?.user.phoneVerified === true;
    this.setData({
      loggedIn,
      phoneVerified,
      loading: silent ? this.data.loading : loggedIn,
      error: "",
      orders: silent ? this.data.orders : [],
      showEmptyOrders: silent ? this.data.showEmptyOrders : false,
    });
    if (!loggedIn) {
      loadInFlight = false;
      return;
    }
    if (!phoneVerified) {
      this.setData({ error: "请先完成手机号验证后查看订单" });
      loadInFlight = false;
      return;
    }
    try {
      const orders = await api<CustomerOrder[]>("/orders");
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
            ...orderProgress(order.status),
            statusLabel: orderStatusLabels[order.status] ?? order.status,
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
            removable: ["CANCELLED", "REFUNDED"].includes(order.status),
            reviewAvailable:
              order.status === "COMPLETED" && order.reviewStatus === null,
            reviewStatusLabel:
              order.reviewStatus === "PENDING_REVIEW"
                ? "评价待审核"
                : order.reviewStatus === "PUBLISHED"
                  ? "评价已公开"
                  : order.reviewStatus === "HIDDEN"
                    ? "评价未公开"
                    : "",
            policyVisible: [
              "PENDING_PAYMENT",
              "PAID",
              "DISPATCHING",
              "ASSIGNED",
              "EN_ROUTE",
              "ARRIVED",
              "REFUNDING",
            ].includes(order.status),
          };
        }),
      );
      this.setData({ orders: this.filterOrders(rows) });
    } catch (error) {
      this.fail(error);
    } finally {
      loadInFlight = false;
      this.setData({
        loading: false,
        showEmptyOrders:
          loggedIn && !this.data.error && this.data.orders.length === 0,
      });
    }
  },
  filterOrders(rows: Row[]) {
    if (this.data.orderFilter === "PENDING_PAYMENT")
      return rows.filter((order) => order.status === "PENDING_PAYMENT");
    if (this.data.orderFilter === "IN_PROGRESS")
      return rows.filter((order) =>
        [
          "PAID",
          "DISPATCHING",
          "ASSIGNED",
          "EN_ROUTE",
          "ARRIVED",
          "IN_SERVICE",
          "AWAITING_CONFIRMATION",
        ].includes(order.status),
      );
    if (this.data.orderFilter === "PENDING_REVIEW")
      return rows.filter(
        (order) => order.status === "COMPLETED" && order.reviewStatus === null,
      );
    if (this.data.orderFilter === "CANCELLED")
      return rows.filter((order) =>
        ["CANCELLED", "REFUNDED"].includes(order.status),
      );
    return rows;
  },
  verifyPhone() {
    goToPhoneVerification();
  },
  openReview(e: { currentTarget: { dataset: { id: string } } }) {
    const order = this.data.orders.find(
      (row: Row) => row.id === e.currentTarget.dataset.id,
    );
    if (!order?.reviewAvailable) {
      this.fail(new Error("只有已完成订单可以评价"));
      return;
    }
    this.setData({
      reviewOpen: true,
      reviewOrderId: order.id,
      reviewRating: 5,
      reviewContent: "",
      error: "",
    });
  },
  closeReview() {
    if (this.data.busy) return;
    this.setData({ reviewOpen: false, reviewOrderId: "", reviewContent: "" });
  },
  keepReviewOpen() {},
  selectReviewRating(e: { currentTarget: { dataset: { rating: number } } }) {
    const rating = Number(e.currentTarget.dataset.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5)
      this.setData({ reviewRating: rating });
  },
  reviewContentChanged(e: { detail: { value: string } }) {
    this.setData({ reviewContent: e.detail.value });
  },
  async submitReview() {
    if (this.data.busy || !this.data.reviewOrderId) return;
    const content = this.data.reviewContent.trim();
    if (content.length < 2) {
      wx.showToast({ title: "请至少填写2个字的真实评价", icon: "none" });
      return;
    }
    const body: TechnicianReviewCreate = {
      rating: this.data.reviewRating,
      content,
    };
    this.setData({ busy: this.data.reviewOrderId, error: "" });
    try {
      await api<TechnicianReview>(
        `/orders/${this.data.reviewOrderId}/reviews`,
        "POST",
        body,
      );
      this.setData({ reviewOpen: false, reviewOrderId: "", reviewContent: "" });
      wx.showToast({ title: "评价已提交审核", icon: "success" });
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
  async action(e: {
    currentTarget: { dataset: { id: string; action: string } };
  }) {
    if (this.data.busy) return;
    const { id, action } = e.currentTarget.dataset;
    this.setData({ busy: id, error: "" });
    try {
      if (action === "friend-pay") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        if (!order || order.status !== "PENDING_PAYMENT")
          throw new Error("只有待付款订单可找人代付，请刷新订单");
        const share = assertFriendPaymentShare(await api<FriendPaymentShare>(
          `/orders/${id}/friend-payment`, "POST", {},
        ), order.payableFen);
        wx.navigateTo({ url: share.miniappPath });
      } else if (action === "pay") {
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
      } else if (action === "remove") {
        const order = this.data.orders.find((row: Row) => row.id === id);
        if (!order?.removable) throw new Error("只能移除已取消或已退款的订单");
        const confirmed = await new Promise<boolean>((resolve) =>
          wx.showModal({
            title: "从我的订单移除？",
            content:
              "订单将从你的列表隐藏，但平台仍会依法保留订单、退款与审计记录，不会硬删除。",
            confirmText: "确认移除",
            success: (result) => resolve(result.confirm === true),
            fail: () => resolve(false),
          }),
        );
        if (!confirmed) return;
        await api(`/orders/${id}`, "DELETE");
        wx.showToast({ title: "已从列表移除", icon: "success" });
      }
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
});

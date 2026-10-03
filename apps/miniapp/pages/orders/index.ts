import type { OrderView, PaymentIntent, RefundView } from "@zydj/contracts";
import { api, money, newKey, shanghaiTime } from "../../utils/api";
import { getStoredSession, loginWithWechat } from "../../utils/auth";
type Row = OrderView & {
  price: string;
  time: string;
  refunds: RefundView[];
  refundAvailable: boolean;
};
Page({
  data: {
    orders: [] as Row[],
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
    this.setData({ loggedIn, loading: loggedIn, error: "", orders: [] });
    if (!loggedIn) return;
    try {
      const orders = await api<OrderView[]>("/orders");
      const rows = await Promise.all(
        orders.map(async (order) => {
          const refunds = await api<RefundView[]>(
            `/orders/${order.id}/refunds`,
          );
          return {
            ...order,
            price: money(order.payableFen),
            time: shanghaiTime(order.appointmentStart),
            refunds,
            refundAvailable:
              [
                "PAID",
                "DISPATCHING",
                "ASSIGNED",
                "EN_ROUTE",
                "ARRIVED",
              ].includes(order.status) &&
              !refunds.some((row) => row.status !== "REJECTED"),
          };
        }),
      );
      this.setData({ orders: rows });
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ loading: false });
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
        const intent = await api<PaymentIntent>(
          `/orders/${id}/payment-intent`,
          "POST",
          {},
        );
        if (intent.provider === "WECHAT") {
          if (intent.status !== "PENDING" || !intent.wechatPayParameters) {
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
        } else {
          if (!intent.mockConfirmationAvailable)
            throw new Error("当前订单不能模拟支付");
          const confirmed = await new Promise<boolean>((resolve) =>
            wx.showModal({
              title: "仅本地模拟支付",
              content:
                "不会扣除微信零钱或银行卡余额。是否标记此测试订单模拟支付成功？",
              success: (result) => resolve(result.confirm),
              fail: () => resolve(false),
            }),
          );
          if (confirmed)
            await api(`/dev/payments/${intent.id}/succeed`, "POST", {});
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
      }
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
});

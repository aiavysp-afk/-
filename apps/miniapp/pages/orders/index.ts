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
        if (!intent.mockConfirmationAvailable)
          throw new Error("真实微信支付尚未通过受控验收，当前不扣款");
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
      } else if (action === "cancel")
        await api(`/orders/${id}/cancel`, "POST", {});
      else if (action === "refund") {
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

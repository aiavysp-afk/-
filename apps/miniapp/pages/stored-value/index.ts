import type {
  CustomerWallet,
  StoredValueRechargeIntent,
  StoredValueCard,
  StoredValueCardStatus,
  StoredValueCardType,
  StoredValueTransaction,
  FirstRechargeRewardClaim,
} from "@zydj/contracts";
import { api, money, newKey, shanghaiTime } from "../../utils/api";
import {
  customerCenterPath,
  getCustomerCenterOrganizationId,
} from "../../utils/customer-center";
import { requireVerifiedCustomerAccess } from "../../utils/auth";

type CardRow = StoredValueCard & {
  balance: string;
  typeLabel: string;
  expiryLabel: string;
};
type LedgerRow = StoredValueTransaction & {
  change: string;
  balanceAfter: string;
  time: string;
};
type RechargePlanRow = CustomerWallet["recharge"]["plans"][number] & {
  amount: string;
};

const typeLabels: Record<StoredValueCardType, string> = {
  PHYSICAL: "实体卡",
  DISCOUNT_93: "93 折卡",
  DISCOUNT_90: "90 折卡",
};

Page({
  data: {
    statusTabs: [
      { key: "AVAILABLE", label: "可用卡" },
      { key: "UNAVAILABLE", label: "不可用卡" },
    ],
    typeTabs: [
      { key: "ALL", label: "全部" },
      { key: "PHYSICAL", label: "实体卡" },
      { key: "DISCOUNT_93", label: "93折卡" },
      { key: "DISCOUNT_90", label: "90折卡" },
    ],
    activeStatus: "AVAILABLE" as StoredValueCardStatus,
    activeType: "ALL" as "ALL" | StoredValueCardType,
    balance: "--",
    balanceKnown: false,
    cards: [] as CardRow[],
    rechargeReason: "正式充值功能尚未开放",
    rechargeEnabled: false,
    rechargePlans: [] as RechargePlanRow[],
    rechargeOpen: false,
    rechargeBusy: false,
    selectedRecharge: 0,
    firstRechargeReason: "",
    firstRechargeStatus:
      "LOCKED" as CustomerWallet["recharge"]["firstRechargeReward"]["status"],
    firstRechargeClaimable: false,
    firstRechargeBusy: false,
    withdrawalReason: "",
    withdrawalEnabled: false,
    withdrawalRule: "提现金额须为 1000 元的整数倍",
    checkInReason: "",
    loading: false,
    error: "",
    ledgerOpen: false,
    ledgerLoading: false,
    ledgerError: "",
    ledger: [] as LedgerRow[],
  },
  back() {
    wx.navigateBack({ delta: 1 });
  },
  async onShow() {
    if (!requireVerifiedCustomerAccess()) return;
    await this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    const params: Record<string, string> = {
      status: this.data.activeStatus,
    };
    if (this.data.activeType !== "ALL") params.type = this.data.activeType;
    try {
      const wallet = await api<CustomerWallet>(
        customerCenterPath("/customer-center/wallet", params),
      );
      this.setData({
        balance: money(wallet.balanceFen),
        balanceKnown: true,
        rechargeReason: wallet.recharge.reason,
        rechargeEnabled: wallet.recharge.enabled,
        rechargePlans: wallet.recharge.plans.map((plan) => ({
          ...plan,
          amount: money(plan.amountFen),
        })),
        firstRechargeReason: wallet.recharge.firstRechargeReward.reason,
        firstRechargeStatus: wallet.recharge.firstRechargeReward.status,
        firstRechargeClaimable: wallet.recharge.firstRechargeReward.enabled,
        withdrawalReason: wallet.withdrawal.reason,
        withdrawalEnabled: wallet.withdrawal.enabled,
        withdrawalRule: `最低 ¥${money(wallet.withdrawal.minimumFen)}，且须按 ¥${money(wallet.withdrawal.stepFen)} 的整数倍申请；${wallet.withdrawal.reviewRequired ? "需要人工复核" : "无需人工复核"}`,
        checkInReason: wallet.checkIn.reason,
        cards: wallet.cards.map((card) => ({
          ...card,
          balance: money(card.balanceFen),
          typeLabel: typeLabels[card.type],
          expiryLabel: card.expiresAt
            ? `有效期至 ${card.expiresAt.slice(0, 10)}`
            : "长期有效",
        })),
      });
    } catch (error) {
      this.setData({
        cards: [],
        balance: "--",
        balanceKnown: false,
        error: error instanceof Error ? error.message : "储值卡读取失败",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
  changeStatus(event: {
    currentTarget: { dataset: { status: StoredValueCardStatus } };
  }) {
    const activeStatus = event.currentTarget.dataset.status;
    if (activeStatus === this.data.activeStatus) return;
    this.setData({ activeStatus });
    void this.load();
  },
  changeType(event: {
    currentTarget: { dataset: { type: "ALL" | StoredValueCardType } };
  }) {
    const activeType = event.currentTarget.dataset.type;
    if (activeType === this.data.activeType) return;
    this.setData({ activeType });
    void this.load();
  },
  recharge() {
    if (!this.data.rechargeEnabled) {
      wx.showToast({ title: "充值通道维护中", icon: "none" });
      return;
    }
    this.setData({ rechargeOpen: true });
  },
  rechargeFirst() {
    const selectedRecharge = this.data.rechargePlans.findIndex(
      (plan) => plan.amountFen === 28_800,
    );
    if (selectedRecharge >= 0) this.setData({ selectedRecharge });
    this.recharge();
  },
  closeRecharge() {
    this.setData({ rechargeOpen: false });
  },
  keepRechargeOpen() {},
  async claimFirstRechargeReward() {
    if (this.data.firstRechargeBusy || !this.data.firstRechargeClaimable)
      return;
    if (!requireVerifiedCustomerAccess()) return;
    this.setData({ firstRechargeBusy: true });
    try {
      await api<FirstRechargeRewardClaim>(
        "/customer-center/wallet/first-recharge-reward/claim",
        "POST",
        { organizationId: getCustomerCenterOrganizationId() },
      );
      await this.load();
      wx.showToast({ title: "88 元红包已到账", icon: "success" });
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "红包领取失败，请重试",
        icon: "none",
      });
    } finally {
      this.setData({ firstRechargeBusy: false });
    }
  },
  selectRecharge(event: { currentTarget: { dataset: { index: number } } }) {
    this.setData({
      selectedRecharge: Number(event.currentTarget.dataset.index),
    });
  },
  async confirmRecharge() {
    if (this.data.rechargeBusy || !this.data.rechargeEnabled) return;
    const plan = this.data.rechargePlans[this.data.selectedRecharge];
    if (!plan) return;
    const confirmed = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: `确认充值 ¥${plan.amount}`,
        content: "确认后将打开微信支付。余额只会在微信成功通知验签后增加。",
        confirmText: "去支付",
        success: (result) => resolve(result.confirm === true),
        fail: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    this.setData({ rechargeBusy: true });
    try {
      const intent = await api<StoredValueRechargeIntent>(
        "/customer-center/wallet/recharges",
        "POST",
        {
          amountFen: plan.amountFen,
          organizationId: getCustomerCenterOrganizationId(),
        },
        newKey(),
      );
      if (
        intent.amountFen !== plan.amountFen ||
        intent.status !== "PENDING" ||
        intent.prepayState !== "READY" ||
        !intent.wechatPayParameters
      )
        throw new Error("充值预下单结果待确认，请稍后查看账单，切勿重复支付");
      const sdkResult = await new Promise<"success" | "cancel" | "failure">(
        (resolve) =>
          wx.requestPayment({
            ...intent.wechatPayParameters!,
            success: () => resolve("success"),
            fail: (error) =>
              resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
          }),
      );
      if (sdkResult === "cancel") {
        wx.showToast({ title: "已取消支付，未增加余额", icon: "none" });
        return;
      }
      const reconciled = await api<StoredValueRechargeIntent>(
        `/customer-center/wallet/recharges/${encodeURIComponent(intent.id)}/reconcile`,
        "POST",
        {},
      );
      if (reconciled.status === "SUCCEEDED") {
        this.setData({ rechargeOpen: false });
        await this.load();
        wx.showToast({ title: "充值已入账", icon: "success" });
      } else {
        wx.showToast({ title: "支付结果确认中，请勿重复支付", icon: "none" });
      }
    } catch (error) {
      wx.showModal({
        title: "充值未完成",
        content: error instanceof Error ? error.message : "充值暂时无法发起",
        showCancel: false,
      });
    } finally {
      this.setData({ rechargeBusy: false });
    }
  },
  showWithdrawalPolicy() {
    wx.showToast({
      title: this.data.withdrawalEnabled ? "请按页面指引申请" : "提现暂未开放",
      icon: "none",
    });
  },
  showCheckInPolicy() {
    wx.showModal({
      title: "签到奖励说明",
      content: this.data.checkInReason,
      showCancel: false,
    });
  },
  async openLedger() {
    this.setData({
      ledgerOpen: true,
      ledgerLoading: true,
      ledgerError: "",
    });
    try {
      const ledger = await api<StoredValueTransaction[]>(
        customerCenterPath("/customer-center/wallet/ledger"),
      );
      this.setData({
        ledger: ledger.map((entry) => ({
          ...entry,
          change: `${entry.changeFen >= 0 ? "+" : "-"}¥${money(
            Math.abs(entry.changeFen),
          )}`,
          balanceAfter: money(entry.balanceAfterFen),
          time: shanghaiTime(entry.occurredAt),
        })),
      });
    } catch (error) {
      this.setData({
        ledger: [],
        ledgerError: error instanceof Error ? error.message : "账单读取失败",
      });
    } finally {
      this.setData({ ledgerLoading: false });
    }
  },
  closeLedger() {
    this.setData({ ledgerOpen: false });
  },
  keepLedgerOpen() {},
});

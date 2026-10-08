import type {
  CustomerWallet,
  StoredValueCard,
  StoredValueCardStatus,
  StoredValueCardType,
  StoredValueTransaction,
} from "@zydj/contracts";
import { api, money, shanghaiTime } from "../../utils/api";
import { customerCenterPath } from "../../utils/customer-center";
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
    wx.showModal({
      title: "充值暂未开放",
      content: `${this.data.rechargeReason}\n\n请勿向个人账户转账，后续正式接入微信支付并完成资金合规后再开放。`,
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

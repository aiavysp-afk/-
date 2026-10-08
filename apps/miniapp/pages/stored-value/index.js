"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const customer_center_1 = require("../../utils/customer-center");
const auth_1 = require("../../utils/auth");
const typeLabels = {
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
        activeStatus: "AVAILABLE",
        activeType: "ALL",
        balance: "--",
        balanceKnown: false,
        cards: [],
        rechargeReason: "正式充值功能尚未开放",
        loading: false,
        error: "",
        ledgerOpen: false,
        ledgerLoading: false,
        ledgerError: "",
        ledger: [],
    },
    back() {
        wx.navigateBack({ delta: 1 });
    },
    async onShow() {
        if (!(0, auth_1.requireVerifiedCustomerAccess)())
            return;
        await this.load();
    },
    async load() {
        this.setData({ loading: true, error: "" });
        const params = {
            status: this.data.activeStatus,
        };
        if (this.data.activeType !== "ALL")
            params.type = this.data.activeType;
        try {
            const wallet = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/wallet", params));
            this.setData({
                balance: (0, api_1.money)(wallet.balanceFen),
                balanceKnown: true,
                rechargeReason: wallet.recharge.reason,
                cards: wallet.cards.map((card) => ({
                    ...card,
                    balance: (0, api_1.money)(card.balanceFen),
                    typeLabel: typeLabels[card.type],
                    expiryLabel: card.expiresAt
                        ? `有效期至 ${card.expiresAt.slice(0, 10)}`
                        : "长期有效",
                })),
            });
        }
        catch (error) {
            this.setData({
                cards: [],
                balance: "--",
                balanceKnown: false,
                error: error instanceof Error ? error.message : "储值卡读取失败",
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    changeStatus(event) {
        const activeStatus = event.currentTarget.dataset.status;
        if (activeStatus === this.data.activeStatus)
            return;
        this.setData({ activeStatus });
        void this.load();
    },
    changeType(event) {
        const activeType = event.currentTarget.dataset.type;
        if (activeType === this.data.activeType)
            return;
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
            const ledger = await (0, api_1.api)((0, customer_center_1.customerCenterPath)("/customer-center/wallet/ledger"));
            this.setData({
                ledger: ledger.map((entry) => ({
                    ...entry,
                    change: `${entry.changeFen >= 0 ? "+" : "-"}¥${(0, api_1.money)(Math.abs(entry.changeFen))}`,
                    balanceAfter: (0, api_1.money)(entry.balanceAfterFen),
                    time: (0, api_1.shanghaiTime)(entry.occurredAt),
                })),
            });
        }
        catch (error) {
            this.setData({
                ledger: [],
                ledgerError: error instanceof Error ? error.message : "账单读取失败",
            });
        }
        finally {
            this.setData({ ledgerLoading: false });
        }
    },
    closeLedger() {
        this.setData({ ledgerOpen: false });
    },
    keepLedgerOpen() { },
});

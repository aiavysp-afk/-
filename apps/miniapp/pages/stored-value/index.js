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
        rechargeEnabled: false,
        rechargePlans: [],
        rechargeOpen: false,
        selectedRecharge: 0,
        firstRechargeReason: "",
        withdrawalReason: "",
        withdrawalRule: "提现金额须为 1000 元的整数倍",
        checkInReason: "",
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
                rechargeEnabled: wallet.recharge.enabled,
                rechargePlans: wallet.recharge.plans.map((plan) => ({
                    ...plan,
                    amount: (0, api_1.money)(plan.amountFen),
                })),
                firstRechargeReason: wallet.recharge.firstRechargeReward.reason,
                withdrawalReason: wallet.withdrawal.reason,
                withdrawalRule: `最低 ¥${(0, api_1.money)(wallet.withdrawal.minimumFen)}，且须按 ¥${(0, api_1.money)(wallet.withdrawal.stepFen)} 的整数倍申请；${wallet.withdrawal.reviewRequired ? "需要人工复核" : "无需人工复核"}`,
                checkInReason: wallet.checkIn.reason,
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
        this.setData({ rechargeOpen: true });
    },
    closeRecharge() {
        this.setData({ rechargeOpen: false });
    },
    keepRechargeOpen() { },
    selectRecharge(event) {
        this.setData({
            selectedRecharge: Number(event.currentTarget.dataset.index),
        });
    },
    confirmRecharge() {
        const plan = this.data.rechargePlans[this.data.selectedRecharge];
        wx.showModal({
            title: plan ? `充值 ¥${plan.amount}` : "充值暂未开放",
            content: `${this.data.rechargeReason}\n\n${this.data.firstRechargeReason}\n\n请勿向个人账户转账；页面不会在支付回调成功前增加余额。`,
            showCancel: false,
        });
    },
    showWithdrawalPolicy() {
        wx.showModal({
            title: "提现规则",
            content: `${this.data.withdrawalRule}\n\n${this.data.withdrawalReason}`,
            showCancel: false,
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

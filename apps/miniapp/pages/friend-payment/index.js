"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const auth_1 = require("../../utils/auth");
const friend_payment_1 = require("../../utils/friend-payment");
Page({
    // Keep the capability and native payment parameters in page memory only.
    shareToken: "",
    originalIntent: null,
    pollTimer: undefined,
    visible: false,
    loadInFlight: false,
    pollRemaining: 0,
    paymentRequestStarted: false,
    paidNoticeShown: false,
    identityRefreshRequired: false,
    data: {
        summary: null,
        loggedIn: false,
        loading: false,
        busy: false,
        error: "",
        amount: "",
        appointmentLabel: "",
        expiresLabel: "",
        statusText: "",
        canPay: false,
        canResumeOriginal: false,
        shareAllowed: false,
        queryOnly: false,
        fulfillmentReviewRequired: false,
        fulfillmentReviewNotice: "款项已到账，原预约需平台核实",
        rightsNotice: friend_payment_1.FRIEND_PAYMENT_RIGHTS_NOTICE,
    },
    onLoad(options) {
        var _a;
        (_a = wx.hideShareMenu) === null || _a === void 0 ? void 0 : _a.call(wx, { menus: ["shareAppMessage", "shareTimeline"] });
        if (!(0, friend_payment_1.isFriendPaymentToken)(options.token)) {
            this.setData({ error: "代付分享无效，请联系下单人重新确认" });
            return;
        }
        this.shareToken = options.token;
    },
    async onShow() {
        var _a;
        this.visible = true;
        this.stopPolling();
        this.setData({ loggedIn: Boolean((0, auth_1.getStoredSession)()) && !this.identityRefreshRequired });
        if (!(0, auth_1.getStoredSession)() || !this.shareToken || this.identityRefreshRequired)
            return;
        await this.loadSummary();
        if (((_a = this.data.summary) === null || _a === void 0 ? void 0 : _a.isOrderOwner) || this.paymentRequestStarted)
            this.startPolling();
    },
    onHide() { this.visible = false; this.stopPolling(); },
    onUnload() {
        this.visible = false;
        this.stopPolling();
        this.shareToken = "";
        this.originalIntent = null;
    },
    login() {
        if (!this.shareToken)
            return;
        // The existing agreement/login page returns to this exact local route.
        // No token is written into session storage or analytics.
        (0, auth_1.redirectToCustomerLogin)((0, friend_payment_1.friendPaymentPath)(this.shareToken));
    },
    async relogin() {
        var _a;
        if (this.data.busy || this.loadInFlight || !this.shareToken)
            return;
        this.stopPolling();
        // A fresh wx.login restores this app's current real identity. Never reuse
        // an old MOCK/other-app session or delete the user's orders and records.
        this.originalIntent = null;
        this.paymentRequestStarted = false;
        this.paidNoticeShown = false;
        this.identityRefreshRequired = true;
        this.setData({ busy: true, loggedIn: false, summary: null, error: "", canPay: false,
            canResumeOriginal: false, shareAllowed: false, queryOnly: false });
        try {
            await (0, auth_1.loginWithWechat)();
            this.identityRefreshRequired = false;
            if (!this.visible)
                return;
            this.setData({ loggedIn: true });
            await this.loadSummary();
            if (((_a = this.data.summary) === null || _a === void 0 ? void 0 : _a.isOrderOwner) || this.paymentRequestStarted)
                this.startPolling();
        }
        catch (error) {
            if (this.visible)
                this.setData({ error: error instanceof Error ? error.message : "微信身份未更新，请重试登录" });
        }
        finally {
            if (this.visible)
                this.setData({ busy: false });
        }
    },
    recordReconcileResult(result) {
        if (result.status === "SUCCEEDED" && result.fulfillmentReviewRequired) {
            // Preserve this verified late-payment warning across subsequent summary
            // refreshes, including CANCELLED; payment does not revive a lost hold.
            this.setData({ fulfillmentReviewRequired: true, canPay: false, canResumeOriginal: false });
        }
    },
    async loadSummary(silent = false) {
        var _a, _b, _c, _d, _e, _f;
        if (this.loadInFlight || !this.shareToken || !(0, auth_1.getStoredSession)() || this.identityRefreshRequired)
            return;
        this.loadInFlight = true;
        if (!silent)
            this.setData({ loading: true, error: "" });
        try {
            const summary = await (0, api_1.api)(`/friend-payments/${this.shareToken}`, "GET", undefined, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken));
            if (!this.visible)
                return;
            if (!summary || !Number.isSafeInteger(summary.amountFen) || summary.amountFen <= 0
                || !Number.isFinite(Date.parse(summary.expiresAt))
                || !Number.isFinite(Date.parse(summary.appointmentAt)))
                throw new Error("代付订单信息未通过核验，请联系下单人");
            // Reopening an already-claimed payment reads the payer's existing intent
            // only. This GET never creates prepay or a new merchant payment number.
            if (!summary.isOrderOwner && summary.paymentClaimedByYou) {
                this.paymentRequestStarted = true;
                if ((0, friend_payment_1.canFriendPay)(summary) && (!this.originalIntent || this.originalIntent.prepayState !== "READY")) {
                    try {
                        this.originalIntent = (0, friend_payment_1.assertFriendPaymentIntent)(await (0, api_1.api)(`/friend-payments/${this.shareToken}/payment-intent`, "GET", undefined, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken)), summary.amountFen);
                    }
                    catch {
                        this.originalIntent = null; /* Unknown results remain query-only. */
                    }
                }
            }
            const shareAllowed = summary.isOrderOwner && summary.state === "PENDING_PAYMENT"
                && Date.parse(summary.expiresAt) > Date.now() && !this.data.fulfillmentReviewRequired;
            const canResumeOriginal = (0, friend_payment_1.canFriendPay)(summary) && Boolean((_a = this.originalIntent) === null || _a === void 0 ? void 0 : _a.wechatPayParameters)
                && ((_b = this.originalIntent) === null || _b === void 0 ? void 0 : _b.prepayState) === "READY" && ((_c = this.originalIntent) === null || _c === void 0 ? void 0 : _c.status) === "PENDING"
                && Date.parse(this.originalIntent.expiresAt) > Date.now() && !this.data.fulfillmentReviewRequired;
            this.setData({
                summary,
                amount: (0, api_1.money)(summary.amountFen),
                appointmentLabel: (0, api_1.shanghaiTime)(summary.appointmentAt),
                expiresLabel: (0, api_1.shanghaiTime)(summary.expiresAt),
                statusText: (0, friend_payment_1.friendPaymentStateText)(summary),
                canPay: (0, friend_payment_1.canFriendPay)(summary) && !this.paymentRequestStarted && !this.data.fulfillmentReviewRequired,
                canResumeOriginal,
                shareAllowed,
                queryOnly: !summary.isOrderOwner && this.paymentRequestStarted && !canResumeOriginal
                    && summary.state !== "PAID" && !this.data.fulfillmentReviewRequired,
                error: "",
            });
            if (shareAllowed)
                (_d = wx.showShareMenu) === null || _d === void 0 ? void 0 : _d.call(wx, { menus: ["shareAppMessage"] });
            else
                (_e = wx.hideShareMenu) === null || _e === void 0 ? void 0 : _e.call(wx, { menus: ["shareAppMessage", "shareTimeline"] });
            if (summary.state === "PAID") {
                this.stopPolling();
                if (!this.paidNoticeShown) {
                    this.paidNoticeShown = true;
                    wx.showToast({
                        title: this.data.fulfillmentReviewRequired ? this.data.fulfillmentReviewNotice
                            : summary.isOrderOwner ? "订单支付已确认" : "服务器已确认支付",
                        icon: this.data.fulfillmentReviewRequired ? "none" : "success",
                    });
                }
            }
        }
        catch (error) {
            if (this.visible)
                this.setData({
                    canPay: false, canResumeOriginal: false, shareAllowed: false,
                    error: error instanceof Error ? error.message : "代付状态读取失败，请刷新",
                });
            (_f = wx.hideShareMenu) === null || _f === void 0 ? void 0 : _f.call(wx, { menus: ["shareAppMessage", "shareTimeline"] });
        }
        finally {
            this.loadInFlight = false;
            if (this.visible)
                this.setData({ loading: false });
        }
    },
    onShareAppMessage() {
        var _a;
        // Only a conscious WeChat share-button/menu tap sends this card. Native
        // share forwarding from a payer/expired page gets a non-secret home path.
        if (!this.data.shareAllowed || !this.shareToken
            || ((_a = this.data.summary) === null || _a === void 0 ? void 0 : _a.state) !== "PENDING_PAYMENT"
            || Date.parse(this.data.summary.expiresAt) <= Date.now())
            return { title: "中原到家 · 正规上门服务", path: "/pages/home/index" };
        return {
            title: `请帮我支付这笔服务订单 · ¥${this.data.amount}`,
            path: (0, friend_payment_1.friendPaymentPath)(this.shareToken),
        };
    },
    stopPolling() {
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
        this.pollRemaining = 0;
    },
    startPolling() {
        this.stopPolling();
        this.pollRemaining = 12;
        this.scheduleNextPoll();
    },
    scheduleNextPoll() {
        const summary = this.data.summary;
        if (!this.visible || !summary || this.pollRemaining <= 0
            || ["PAID", "CANCELLED", "EXPIRED", "UNAVAILABLE"].includes(summary.state))
            return;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            --this.pollRemaining;
            void this.loadSummary(true).then(() => this.scheduleNextPoll());
        }, 5000);
    },
    async queryPayment() {
        var _a, _b;
        if (this.data.busy || !this.shareToken || !(0, auth_1.getStoredSession)() || this.identityRefreshRequired)
            return;
        this.setData({ busy: true, error: "" });
        try {
            if (this.paymentRequestStarted && !((_a = this.data.summary) === null || _a === void 0 ? void 0 : _a.isOrderOwner)) {
                const result = await (0, api_1.api)(`/friend-payments/${this.shareToken}/reconcile`, "POST", {}, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken));
                this.recordReconcileResult(result);
            }
        }
        catch (error) {
            this.setData({ error: error instanceof Error ? error.message : "支付结果尚未确认" });
        }
        finally {
            await this.loadSummary();
            this.setData({ busy: false });
            if (((_b = this.data.summary) === null || _b === void 0 ? void 0 : _b.isOrderOwner) || this.paymentRequestStarted)
                this.startPolling();
        }
    },
    async pay() {
        var _a;
        if (this.data.busy || this.loadInFlight || !this.shareToken || this.data.fulfillmentReviewRequired || this.identityRefreshRequired)
            return;
        if (!(0, auth_1.getStoredSession)()) {
            this.login();
            return;
        }
        await this.loadSummary();
        const summary = this.data.summary;
        if (!(0, friend_payment_1.canFriendPay)(summary) || !summary)
            return;
        if (this.paymentRequestStarted && !((_a = this.originalIntent) === null || _a === void 0 ? void 0 : _a.wechatPayParameters)) {
            await this.queryPayment();
            return;
        }
        this.setData({ busy: true, error: "" });
        try {
            const confirmed = await new Promise((resolve) => wx.showModal({
                title: "确认微信好友代付",
                content: `你将用自己的微信账户支付 ¥${(0, api_1.money)(summary.amountFen)}。${friend_payment_1.FRIEND_PAYMENT_RIGHTS_NOTICE}`,
                confirmText: "微信付款",
                success: (result) => resolve(result.confirm === true),
                fail: () => resolve(false),
            }));
            if (!confirmed || !this.visible)
                return;
            if (!this.originalIntent) {
                // Mark before the request leaves the device: an uncertain response is
                // query-only and can never trigger a second payment-intent POST here.
                this.paymentRequestStarted = true;
                this.setData({ canPay: false, queryOnly: true });
                this.originalIntent = (0, friend_payment_1.assertFriendPaymentIntent)(await (0, api_1.api)(`/friend-payments/${this.shareToken}/payment-intent`, "POST", {}, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken)), summary.amountFen);
            }
            const intent = (0, friend_payment_1.assertFriendPaymentIntent)(this.originalIntent, summary.amountFen);
            if (intent.status !== "PENDING" || intent.prepayState !== "READY" || !intent.wechatPayParameters) {
                const result = await (0, api_1.api)(`/friend-payments/${this.shareToken}/reconcile`, "POST", {}, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken));
                this.recordReconcileResult(result);
                return;
            }
            const sdkResult = await new Promise((resolve) => wx.requestPayment({
                ...intent.wechatPayParameters,
                success: () => resolve("success"),
                fail: (error) => resolve(error.errMsg.includes("cancel") ? "cancel" : "failure"),
            }));
            // Native SDK success is not proof of settlement. Only server-verified
            // reconciliation and the refreshed PAID summary can announce success.
            try {
                const result = await (0, api_1.api)(`/friend-payments/${this.shareToken}/reconcile`, "POST", {}, undefined, (0, friend_payment_1.friendPaymentPath)(this.shareToken));
                this.recordReconcileResult(result);
            }
            catch { /* Keep the original intent and query the real result later. */ }
            if (this.data.fulfillmentReviewRequired)
                wx.showToast({ title: this.data.fulfillmentReviewNotice, icon: "none" });
            else if (sdkResult === "cancel")
                wx.showToast({ title: "已取消支付，订单未取消", icon: "none" });
            else
                wx.showToast({ title: "正在确认服务器支付结果", icon: "none" });
        }
        catch (error) {
            this.setData({ error: error instanceof Error ? error.message : "代付结果待确认，请查询原支付" });
        }
        finally {
            await this.loadSummary();
            this.setData({ busy: false });
            if (this.paymentRequestStarted)
                this.startPolling();
        }
    },
    openOrders() { wx.redirectTo({ url: "/pages/orders/index" }); },
    openHome() { wx.switchTab({ url: "/pages/home/index" }); },
});

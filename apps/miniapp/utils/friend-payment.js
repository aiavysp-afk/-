"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFriendPaymentToken = exports.FRIEND_PAYMENT_RIGHTS_NOTICE = void 0;
exports.friendPaymentPath = friendPaymentPath;
exports.safeFriendPaymentReturnPath = safeFriendPaymentReturnPath;
exports.assertFriendPaymentShare = assertFriendPaymentShare;
exports.canFriendPay = canFriendPay;
exports.assertFriendPaymentIntent = assertFriendPaymentIntent;
exports.friendPaymentStateText = friendPaymentStateText;
// A share token is a secret capability, not an order identifier. Never persist
// it in storage, log it, or include it in analytics and error diagnostics.
exports.FRIEND_PAYMENT_RIGHTS_NOTICE = "代付成功后资金进入平台，订单权益归下单人。代付人不能发起退款，退款只能由下单用户申请，审核通过后原路退回实际微信付款账户。";
const isFriendPaymentToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
exports.isFriendPaymentToken = isFriendPaymentToken;
function friendPaymentPath(token) {
    if (!(0, exports.isFriendPaymentToken)(token))
        throw new Error("代付分享已失效，请联系下单人重新确认");
    return `/pages/friend-payment/index?token=${token}`;
}
function safeFriendPaymentReturnPath(value) {
    if (typeof value !== "string")
        return "";
    let candidate = value;
    // wx navigation query parameters can arrive percent-encoded. Decode exactly
    // once, then enforce the same closed, local route allowlist.
    if (candidate.startsWith("%2Fpages%2Ffriend-payment%2Findex%3Ftoken%3D")) {
        try {
            candidate = decodeURIComponent(candidate);
        }
        catch {
            return "";
        }
    }
    const match = /^\/pages\/friend-payment\/index\?token=([A-Za-z0-9_-]{43})$/.exec(candidate);
    return (match === null || match === void 0 ? void 0 : match[1]) ? friendPaymentPath(match[1]) : "";
}
function assertFriendPaymentShare(share, amountFen) {
    if (!share || !(0, exports.isFriendPaymentToken)(share.token)
        || share.miniappPath !== friendPaymentPath(share.token)
        || !Number.isSafeInteger(share.amountFen) || share.amountFen <= 0
        || share.amountFen !== amountFen || !Number.isFinite(Date.parse(share.expiresAt))
        || Date.parse(share.expiresAt) <= Date.now())
        throw new Error("代付订单金额或分享有效期未通过核验，请刷新原订单");
    return share;
}
function canFriendPay(summary, now = Date.now()) {
    return Boolean(summary && !summary.isOrderOwner && summary.canPay
        && summary.state === "PENDING_PAYMENT" && Date.parse(summary.expiresAt) > now
        && Number.isSafeInteger(summary.amountFen) && summary.amountFen > 0);
}
function assertFriendPaymentIntent(intent, amountFen) {
    if (!intent || intent.provider !== "WECHAT" || !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id)
        || !Number.isSafeInteger(intent.amountFen) || intent.amountFen <= 0
        || intent.amountFen !== amountFen
        || !Number.isFinite(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= Date.now())
        throw new Error("微信代付金额未通过核验，请先查询原支付结果");
    return intent;
}
function friendPaymentStateText(summary) {
    if (summary.state === "PAID")
        return "订单已支付，请勿再次付款";
    if (summary.state === "CANCELLED")
        return "订单已取消，不能代付";
    if (summary.state === "EXPIRED" || Date.parse(summary.expiresAt) <= Date.now())
        return "代付分享已过期，不能付款";
    if (summary.state === "PAYMENT_IN_PROGRESS")
        return "已有支付正在确认中，请勿重复付款";
    if (summary.state === "UNAVAILABLE")
        return "当前订单不可代付，请联系下单人";
    if (summary.isOrderOwner)
        return "请分享给微信好友；你是下单人，不能为自己发起好友代付";
    if (!summary.canPay)
        return "该订单暂不能代付，可能已有其他好友准备付款";
    return "请核对项目与金额，由你自己的微信账户完成付款";
}

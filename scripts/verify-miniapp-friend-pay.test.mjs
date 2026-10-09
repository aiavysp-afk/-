import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const helpers = require("../apps/miniapp/utils/friend-payment.js");
const token = "f".repeat(43);
const path = `/pages/friend-payment/index?token=${token}`;
const summary = (extra = {}) => ({
  state: "PENDING_PAYMENT", serviceItems: [{ serviceName: "法式 SPA", durationMinutes: 120, quantity: 1 }],
  serviceProviderName: "中原到家", appointmentAt: "2099-01-01T04:00:00.000Z", amountFen: 45800,
  expiresAt: "2099-01-01T03:00:00.000Z", isOrderOwner: false, canPay: true,
  paymentClaimedByYou: false, rightsNotice: helpers.FRIEND_PAYMENT_RIGHTS_NOTICE, ...extra,
});
const intent = (extra = {}) => ({
  id: "payment-fixture", orderId: "order-fixture", provider: "WECHAT", status: "PENDING",
  amountFen: 45800, expiresAt: "2099-01-01T03:00:00.000Z", mockConfirmationAvailable: false,
  prepayState: "READY", wechatPayParameters: {
    timeStamp: "123", nonceStr: "fixture-nonce", package: "prepay_id=fixture", signType: "RSA", paySign: "fixture-signature",
  }, ...extra,
});
const source = (file) => readFileSync(new URL(`../apps/miniapp/${file}`, import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ initial = summary(), session = { user: { id: "friend", phoneVerified: false } }, sdk = "success", settle = false, paymentIntent = intent(), handler, loginFailure = false } = {}) {
  let current = initial, page, nextTimer = 1;
  const calls = [], toasts = [], navigation = [], sdkCalls = [], timers = new Map(), shares = [], freshLogins = [];
  const api = async (endpoint, method = "GET", data, key, returnPath) => {
    calls.push({ endpoint, method, data, key, returnPath });
    const custom = await handler?.(endpoint, method, data);
    if (custom !== undefined) return custom;
    if (endpoint.endsWith("/payment-intent")) {
      current = { ...current, paymentClaimedByYou: true };
      return paymentIntent;
    }
    if (endpoint.endsWith("/reconcile")) {
      if (settle) current = { ...current, state: "PAID", canPay: false };
      return { id: "payment-fixture", status: settle ? "SUCCEEDED" : "PENDING", fulfillmentReviewRequired: false };
    }
    if (endpoint === `/friend-payments/${token}`) return current;
    throw new Error("Unexpected test endpoint");
  };
  vm.runInNewContext(source("pages/friend-payment/index.js"), {
    exports: {}, Error,
    Page(definition) { page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } }; },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === "../../utils/friend-payment") return helpers;
      if (name === "../../utils/api") return { api, money: (fen) => (fen / 100).toFixed(2), shanghaiTime: (iso) => iso };
      if (name === "../../utils/auth") return {
        getStoredSession: () => session, redirectToCustomerLogin: (returnPath) => navigation.push(returnPath),
        loginWithWechat: async () => {
          freshLogins.push("fresh-wx-login");
          if (loginFailure) throw new Error("微信登录暂时失败");
          session = { user: { id: "real-wechat-friend", phoneVerified: false } };
          return session;
        },
      };
      throw new Error("Unexpected compiled dependency");
    },
    wx: {
      hideShareMenu: (options) => shares.push({ hidden: true, ...options }), showShareMenu: (options) => shares.push(options),
      showModal: (options) => options.success?.({ confirm: true, cancel: false }), showToast: (options) => toasts.push(options),
      requestPayment(options) { sdkCalls.push(options); if (sdk === "success") options.success(); else options.fail({ errMsg: `requestPayment:fail ${sdk}` }); },
      redirectTo: (options) => navigation.push(options.url), switchTab: (options) => navigation.push(options.url),
    },
  });
  return {
    page, calls, toasts, navigation, sdkCalls, timers, shares, freshLogins,
    setSummary(next) { current = next; },
    async open() { page.onLoad({ token }); await page.onShow(); },
    async tick() { const entry = timers.entries().next().value; if (!entry) return; timers.delete(entry[0]); entry[1](); await flush(); },
  };
}

test("share paths accept only the exact local route and a 256-bit URL-safe capability", () => {
  assert.equal(helpers.friendPaymentPath(token), path);
  assert.equal(helpers.safeFriendPaymentReturnPath(path), path);
  assert.equal(helpers.safeFriendPaymentReturnPath(encodeURIComponent(path)), path);
  for (const candidate of [`https://evil.invalid${path}`, `${path}&next=https://evil.invalid`, `${path}#x`, path.replace("friend-payment", "orders"), "%252Fpages%252Ffriend-payment", "../../orders"])
    assert.equal(helpers.safeFriendPaymentReturnPath(candidate), "");
  for (const candidate of ["", "f".repeat(42), "f".repeat(44), "../".repeat(15), null]) assert.equal(helpers.isFriendPaymentToken(candidate), false);
});

test("server share amounts and expiry are checked before navigating", () => {
  const share = { token, miniappPath: path, amountFen: 45800, expiresAt: "2099-01-01T03:00:00.000Z" };
  assert.equal(helpers.assertFriendPaymentShare(share, 45800), share);
  for (const change of [{ amountFen: 45799 }, { miniappPath: "/pages/orders/index" }, { expiresAt: "2000-01-01T00:00:00Z" }, { token: "invalid" }])
    assert.throws(() => helpers.assertFriendPaymentShare({ ...share, ...change }, 45800));
});

test("only pending, unexpired, positive-amount non-owner summaries can pay", () => {
  assert.equal(helpers.canFriendPay(summary()), true);
  for (const state of ["PAID", "CANCELLED", "EXPIRED", "PAYMENT_IN_PROGRESS", "UNAVAILABLE"])
    assert.equal(helpers.canFriendPay(summary({ state })), false);
  for (const extra of [{ isOrderOwner: true }, { canPay: false }, { expiresAt: "2000-01-01T00:00:00Z" }, { amountFen: 0 }, { amountFen: 0.5 }])
    assert.equal(helpers.canFriendPay(summary(extra)), false);
});

test("fake providers and changed server payment amounts never reach native WeChat", () => {
  assert.equal(helpers.assertFriendPaymentIntent(intent(), 45800).provider, "WECHAT");
  for (const extra of [{ provider: "MOCK" }, { amountFen: 45799 }, { amountFen: 0 }, { id: "bad/path" }])
    assert.throws(() => helpers.assertFriendPaymentIntent(intent(extra), 45800));
});

test("owner gets a voluntary WeChat share card without contact information and cannot self-pay", async () => {
  const host = fixture({ initial: summary({ isOrderOwner: true, canPay: false }) });
  await host.open();
  assert.equal(host.page.data.shareAllowed, true);
  assert.equal(host.page.onShareAppMessage().path, path);
  assert.equal(host.page.onShareAppMessage().title, "请帮我支付这笔服务订单 · ¥458.00");
  await host.page.pay();
  assert.equal(host.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(host.sdkCalls.length, 0);
  const markup = source("pages/friend-payment/index.wxml");
  assert.match(markup, /open-type="share"/);
  assert.doesNotMatch(markup, /contactName|phone|latitude|longitude|orderNo/);
});

test("payer and expired owner share handlers return only the non-secret home path", async () => {
  const payer = fixture(); await payer.open();
  assert.equal(payer.page.onShareAppMessage().path, "/pages/home/index");
  const owner = fixture({ initial: summary({ isOrderOwner: true, expiresAt: "2000-01-01T00:00:00Z" }) });
  await owner.open();
  assert.equal(owner.page.data.shareAllowed, false);
  assert.equal(owner.page.onShareAppMessage().path, "/pages/home/index");
});

test("new friends preserve the exact share route through login, without phone collection or a payment POST", async () => {
  const host = fixture({ session: undefined });
  // An explicit null denotes no real WeChat identity in the fixture.
  const unauthenticated = fixture({ session: null });
  await unauthenticated.open(); unauthenticated.page.login();
  assert.deepEqual(unauthenticated.navigation, [path]);
  assert.equal(unauthenticated.calls.length, 0);
  await host.open();
  assert.equal(host.page.data.loggedIn, true);
  assert.equal(host.page.data.canPay, true); // WeChat identity, unverified phone.
});

test("paid, cancelled, expired and competing-payer pages cannot create a payment", async () => {
  for (const extra of [{ state: "PAID" }, { state: "CANCELLED" }, { state: "EXPIRED" }, { state: "PAYMENT_IN_PROGRESS" }, { state: "UNAVAILABLE" }, { canPay: false }]) {
    const host = fixture({ initial: summary(extra) }); await host.open(); await host.page.pay();
    assert.equal(host.page.data.canPay, false);
    assert.equal(host.calls.some((call) => call.endpoint.endsWith("/payment-intent")), false);
    assert.equal(host.sdkCalls.length, 0);
  }
});

test("native SDK success alone is pending, never local settlement proof", async () => {
  const host = fixture({ settle: false }); await host.open(); await host.page.pay();
  assert.equal(host.sdkCalls.length, 1);
  assert.equal(host.page.data.summary.state, "PENDING_PAYMENT");
  assert.equal(host.toasts.some((toast) => toast.icon === "success"), false);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "POST").length, 1);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/reconcile") && call.method === "POST").length, 1);
  assert.equal(host.calls.at(-1).method, "GET");
});

test("only a verified PAID server summary announces payment success", async () => {
  const host = fixture({ settle: true }); await host.open(); await host.page.pay();
  assert.equal(host.page.data.summary.state, "PAID");
  assert.equal(host.page.data.canPay, false);
  assert.equal(host.toasts.filter((toast) => toast.icon === "success").length, 1);
  await host.page.pay();
  assert.equal(host.sdkCalls.length, 1);
  assert.equal(host.timers.size, 0);
});

test("SDK cancel preserves the same intent and can resume native payment without another POST", async () => {
  const host = fixture({ sdk: "cancel" }); await host.open(); await host.page.pay();
  assert.equal(host.page.data.canResumeOriginal, true);
  await host.page.pay();
  assert.equal(host.sdkCalls.length, 2);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "POST").length, 1);
});

test("reopening an already-claimed READY payment reads its existing intent and never creates another", async () => {
  const host = fixture({ initial: summary({ paymentClaimedByYou: true }), sdk: "cancel" });
  await host.open();
  assert.equal(host.page.data.canPay, false);
  assert.equal(host.page.data.canResumeOriginal, true);
  assert.equal(host.page.data.queryOnly, false);
  await host.page.pay();
  assert.equal(host.sdkCalls.length, 1);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "GET").length, 1);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "POST").length, 0);
});

test("reopened UNKNOWN and unauthorized original intents remain query-only with no SDK or new POST", async () => {
  for (const scenario of [
    { paymentIntent: intent({ prepayState: "UNKNOWN", wechatPayParameters: undefined }) },
    { handler(endpoint, method) { if (endpoint.endsWith("/payment-intent") && method === "GET") throw new Error("身份不匹配"); } },
    { paymentIntent: intent({ expiresAt: "2000-01-01T00:00:00Z" }) },
  ]) {
    const host = fixture({ initial: summary({ paymentClaimedByYou: true }), ...scenario });
    await host.open(); await host.page.pay();
    assert.equal(host.page.data.canResumeOriginal, false);
    assert.equal(host.page.data.queryOnly, true);
    assert.equal(host.sdkCalls.length, 0);
    assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "POST").length, 0);
  }
});

test("a lost payment-intent response remains query-only with no duplicate POST", async () => {
  const host = fixture({ handler(endpoint, method) {
    if (endpoint.endsWith("/payment-intent") && method === "POST") throw new Error("网络状态未知");
  } });
  await host.open(); await host.page.pay(); await host.page.pay();
  assert.equal(host.page.paymentRequestStarted, true);
  assert.equal(host.sdkCalls.length, 0);
  assert.equal(host.calls.filter((call) => call.endpoint.endsWith("/payment-intent") && call.method === "POST").length, 1);
  assert.equal(host.calls.some((call) => call.endpoint.endsWith("/reconcile")), true);
});

test("changed payment amounts or mock responses never invoke WeChat", async () => {
  for (const paymentIntent of [intent({ provider: "MOCK" }), intent({ amountFen: 45000 })]) {
    const host = fixture({ paymentIntent }); await host.open(); await host.page.pay();
    assert.equal(host.sdkCalls.length, 0);
    assert.equal(host.page.data.canPay, false);
    assert.equal(host.toasts.some((toast) => toast.icon === "success"), false);
  }
});

test("owner polls only a bounded minute and stops when the page is hidden", async () => {
  const host = fixture({ initial: summary({ isOrderOwner: true, canPay: false }) }); await host.open();
  for (let attempt = 0; attempt < 15; ++attempt) await host.tick();
  assert.equal(host.calls.length, 13); // Initial GET + 12 bounded updates.
  assert.equal(host.timers.size, 0);
  host.page.startPolling(); assert.equal(host.timers.size, 1);
  host.page.onHide(); assert.equal(host.timers.size, 0);
});

test("owner receives a server-confirmed toast and stale sharing is disabled after payment", async () => {
  const host = fixture({ initial: summary({ isOrderOwner: true, canPay: false }) }); await host.open();
  host.setSummary(summary({ isOrderOwner: true, canPay: false, state: "PAID" })); await host.tick();
  assert.equal(host.page.data.shareAllowed, false);
  assert.equal(host.toasts.at(-1).title, "订单支付已确认");
  assert.equal(host.timers.size, 0);
  assert.equal(host.page.onShareAppMessage().path, "/pages/home/index");
});

test("booking branches to a verified share before owner prepay and the order list can continue sharing", () => {
  const booking = source("pages/booking/index.ts"), orders = source("pages/orders/index.ts");
  assert.match(booking, /paymentMode === "FRIEND"[\s\S]*await this\.shareCreatedOrder\(order\);[\s\S]*return;[\s\S]*await this\.payCreatedOrder\(order\)/);
  assert.match(booking, /`\/orders\/\$\{order\.id\}\/friend-payment`, "POST", \{\}/);
  assert.match(orders, /action === "friend-pay"[\s\S]*order\.status !== "PENDING_PAYMENT"/);
  assert.match(orders, /assertFriendPaymentShare/);
  assert.match(source("pages/booking/index.wxml"), /data-mode="FRIEND"/);
  assert.match(source("pages/orders/index.wxml"), /data-action="friend-pay"/);
  assert.match(source("pages/friend-payment/index.wxml"), /代付人不能发起退款|rightsNotice/);
  assert.match(helpers.FRIEND_PAYMENT_RIGHTS_NOTICE, /原路退回实际微信付款账户/);
});

test("tokens are redacted in generic API errors and are never stored or logged by the share page", async () => {
  let redirect, exported = {};
  vm.runInNewContext(source("utils/api.js"), {
    exports: exported, Error,
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.invalid/v1" } }),
    require: () => ({ getStoredSession: () => undefined, clearStoredSession() {}, redirectToCustomerLogin: (next) => { redirect = next; } }),
    wx: { request: (options) => options.success({ statusCode: 401, data: { message: "登录已过期" } }) },
  });
  await assert.rejects(exported.api(`/friend-payments/${token}/payment-intent`, "POST", {}, undefined, path), (error) => {
    assert.equal(error.path, "/friend-payments/[redacted]/payment-intent");
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  assert.equal(redirect, path);
  const page = source("pages/friend-payment/index.ts");
  assert.doesNotMatch(page, /console\.|setStorageSync|setClipboardData|reportAnalytics|requestSubscribeMessage/);
  const sitemap = JSON.parse(source("sitemap.json"));
  assert.deepEqual(sitemap.rules[0], { action: "disallow", page: "pages/friend-payment/index" });
});

test("message page uses persisted owner-only notices rather than inventing push messages", () => {
  const messages = source("pages/messages/index.ts");
  assert.match(messages, /api<PaymentNotification\[\]>\("\/payments\/notifications"\)/);
  assert.match(messages, /notification\.title/);
  assert.match(messages, /notification\.body/);
  assert.doesNotMatch(messages, /requestSubscribeMessage|sendSubscription/);
});

test("friend return login requires agreement and real WeChat identity but not phone authorization", async () => {
  let page, session, loginCalls = 0;
  const navigation = [];
  vm.runInNewContext(source("pages/phone-verification/index.js"), {
    exports: {}, Error, clearInterval() {},
    Page(definition) { page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } }; },
    require(name) {
      if (name === "../../utils/friend-payment") return helpers;
      if (name === "../../utils/auth") return {
        getStoredSession: () => session,
        loginWithWechat: async () => { ++loginCalls; session = { user: { phoneVerified: false } }; return session; },
        needsPhoneVerification: () => true,
      };
      throw new Error("Unexpected dependency");
    },
    wx: { showToast() {}, showModal() {}, redirectTo: (options) => navigation.push(options.url), switchTab: (options) => navigation.push(options.url) },
  });
  page.onLoad({ required: "1", returnPath: encodeURIComponent(path) });
  page.data.accepted = false;
  await page.authorizeWechat(); assert.equal(loginCalls, 0);
  page.data.accepted = true;
  await page.authorizeWechat(); assert.equal(loginCalls, 1);
  assert.equal(page.data.completed, true);
  assert.equal(page.data.friendPaymentReturn, true);
  assert.equal(session.user.phoneVerified, false);
  page.enterHome(); assert.deepEqual(navigation, [path]);
});

test("ordinary login without a valid friend route still requires phone verification", async () => {
  let page;
  vm.runInNewContext(source("pages/phone-verification/index.js"), {
    exports: {}, Error,
    Page(definition) { page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } }; },
    require(name) {
      if (name === "../../utils/friend-payment") return helpers;
      return {
        getStoredSession: () => undefined,
        loginWithWechat: async () => ({ user: { phoneVerified: false } }),
        needsPhoneVerification: () => true,
      };
    },
    wx: { showToast() {}, showModal() {} },
  });
  page.onLoad({ required: "1", returnPath: `https://evil.invalid${path}` });
  await page.authorizeWechat();
  assert.equal(page.data.friendPaymentReturn, false);
  assert.equal(page.data.completed, false);
  assert.equal(page.data.wechatReady, true);
});

test("reconcile late-payment warning survives cancelled summary refresh without promising revived service", async () => {
  const host = fixture({ initial: summary({ paymentClaimedByYou: true }), handler(endpoint) {
    if (endpoint.endsWith("/reconcile")) {
      host.setSummary(summary({ state: "CANCELLED", canPay: false, paymentClaimedByYou: true }));
      return { id: "payment-fixture", status: "SUCCEEDED", fulfillmentReviewRequired: true };
    }
  } });
  await host.open(); await host.page.queryPayment();
  assert.equal(host.page.data.summary.state, "CANCELLED");
  assert.equal(host.page.data.fulfillmentReviewRequired, true);
  assert.equal(host.page.data.fulfillmentReviewNotice, "款项已到账，原预约需平台核实");
  await host.page.loadSummary();
  assert.equal(host.page.data.fulfillmentReviewRequired, true);
  assert.equal(host.page.data.canPay, false);
  assert.equal(host.page.data.canResumeOriginal, false);
  assert.equal(host.sdkCalls.length, 0);
  assert.match(source("pages/friend-payment/index.wxml"), /已付款不代表原预约自动恢复/);
  assert.doesNotMatch(source("pages/friend-payment/index.wxml"), /服务已安排|服务将按平台正常流程安排/);
});

test("pay reconciliation keeps the verified late-payment warning after native SDK success", async () => {
  const host = fixture({ handler(endpoint) {
    if (endpoint.endsWith("/reconcile")) {
      host.setSummary(summary({ state: "CANCELLED", canPay: false, paymentClaimedByYou: true }));
      return { id: "payment-fixture", status: "SUCCEEDED", fulfillmentReviewRequired: true };
    }
  } });
  await host.open(); await host.page.pay();
  assert.equal(host.sdkCalls.length, 1);
  assert.equal(host.page.data.fulfillmentReviewRequired, true);
  assert.equal(host.page.data.summary.state, "CANCELLED");
  assert.equal(host.toasts.at(-1).title, "款项已到账，原预约需平台核实");
  assert.equal(host.toasts.some((toast) => toast.icon === "success"), false);
});

test("pending reconcile cannot invent the funds-arrived warning", async () => {
  const host = fixture({ initial: summary({ paymentClaimedByYou: true }), handler(endpoint) {
    if (endpoint.endsWith("/reconcile")) return { id: "payment-fixture", status: "PENDING", fulfillmentReviewRequired: true };
  } });
  await host.open(); await host.page.queryPayment();
  assert.equal(host.page.data.fulfillmentReviewRequired, false);
  assert.equal(host.toasts.some((toast) => /已到账/.test(toast.title)), false);
});

test("explicit re-login obtains fresh current-app WeChat identity and preserves records without phone or new prepay", async () => {
  const host = fixture({ initial: summary({ paymentClaimedByYou: true }), session: { user: { id: "old-mock-session", phoneVerified: true } } });
  await host.open();
  assert.ok(host.page.originalIntent);
  await host.page.relogin();
  assert.deepEqual(host.freshLogins, ["fresh-wx-login"]);
  assert.equal(host.page.data.loggedIn, true);
  assert.equal(host.page.data.canResumeOriginal, true);
  assert.equal(host.calls.some((call) => call.method === "DELETE"), false);
  assert.equal(host.calls.some((call) => call.method === "POST"), false);
  assert.equal(host.calls.some((call) => /phone|refund/.test(call.endpoint)), false);
  assert.match(source("pages/friend-payment/index.wxml"), /bindtap="relogin"/);
});

test("failed fresh login discards cached SDK parameters and never falls back to the old identity", async () => {
  const host = fixture({ initial: summary({ paymentClaimedByYou: true }), loginFailure: true });
  await host.open();
  assert.ok(host.page.originalIntent);
  const callsBefore = host.calls.length;
  await host.page.relogin();
  assert.equal(host.freshLogins.length, 1);
  assert.equal(host.page.originalIntent, null);
  assert.equal(host.page.data.canPay, false);
  assert.equal(host.page.data.canResumeOriginal, false);
  assert.equal(host.page.data.loggedIn, false);
  assert.equal(host.calls.length, callsBefore);
  await host.page.pay(); await host.page.queryPayment(); await host.page.onShow();
  assert.equal(host.calls.length, callsBefore);
  assert.equal(host.sdkCalls.length, 0);
});

test("friend return login never skips fresh wx.login for a stored old identity", async () => {
  let page, loginCalls = 0;
  const navigation = [];
  let session = { user: { id: "old-mock-identity", phoneVerified: true } };
  vm.runInNewContext(source("pages/phone-verification/index.js"), {
    exports: {}, Error,
    Page(definition) { page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } }; },
    require(name) {
      if (name === "../../utils/friend-payment") return helpers;
      return {
        getStoredSession: () => session,
        loginWithWechat: async () => { ++loginCalls; session = { user: { id: "real-current-app-identity", phoneVerified: false } }; return session; },
        needsPhoneVerification: () => true,
      };
    },
    wx: { showToast() {}, showModal() {}, redirectTo: (options) => navigation.push(options.url) },
  });
  page.onLoad({ required: "1", returnPath: encodeURIComponent(path) });
  assert.equal(page.data.completed, false);
  assert.equal(page.data.wechatReady, false);
  page.enterHome(); assert.equal(navigation.length, 0);
  await page.authorizeWechat();
  assert.equal(loginCalls, 1);
  assert.equal(page.data.completed, true);
  assert.equal(session.user.phoneVerified, false);
  page.enterHome(); assert.deepEqual(navigation, [path]);
});

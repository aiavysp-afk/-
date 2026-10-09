import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const booking = require("../apps/miniapp/utils/booking.js");
const { ApiError } = require("../apps/miniapp/utils/api.js");
const now = Date.parse("2026-10-09T04:00:00.000Z");
const coupon = (id, amountFen, minimumSpendFen, extra = {}) => ({
  id, organizationId: "org-fixture", title: `${amountFen / 100}元优惠券`, amountFen, minimumSpendFen,
  applicability: "仅项目费", canApplyToTravelFee: false, status: "AVAILABLE",
  validFrom: "2026-10-01T00:00:00.000Z", expiresAt: "2099-12-31T00:00:00.000Z", usedAt: null, ...extra,
});
const coupons = [coupon("coupon40", 4000, 49800), coupon("coupon30", 3000, 39800),
  coupon("coupon20", 2000, 29800), coupon("coupon10", 1000, 19800)];
const slot = (index) => ({ therapistId: `tech-${index}`, startsAt: `2099-01-01T0${index}:00:00.000Z`, endsAt: `2099-01-01T0${index + 1}:00:00.000Z` });
const quote = (reservationId, discountFen = 4000, couponId = "coupon40") => ({
  reservationId, couponId, serviceAmountFen: 49800, travelFeeFen: 0, discountFen,
  payableFen: 49800 - discountFen, currency: "CNY", moneyUnit: "fen",
});
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(handler = () => undefined) {
  const calls = [], timers = new Map(), toasts = [], modals = [];
  let page, nextTimer = 1, nextHold = 1, nextKey = 1;
  const api = async (path, method = "GET", data, key) => {
    calls.push({ path, method, data, key });
    const value = await handler(path, data, calls);
    if (value !== undefined) return value;
    if (path.startsWith("/customer-center/coupons")) return coupons;
    if (path === "/booking-holds") return {
      id: `hold-${nextHold++}`, ...data, expiresAt: "2099-01-01T00:00:00.000Z", status: "HOLD",
    };
    if (/\/booking-holds\/.*\/release/.test(path)) return { released: true };
    if (path === "/orders/quote") return quote(data.reservationId, data.couponId === null ? 0 : 4000, data.couponId === null ? null : "coupon40");
    if (path === "/locations/address-geocodes") return { latitude: 34.7, longitude: 113.7, coordinateSystem: "GCJ-02" };
    if (path === "/locations/address-verifications") return { id: "verified-address" };
    if (path === "/orders") return {
      id: "order-fixture", status: "PENDING_PAYMENT", ...quote(data.reservationId),
    };
    throw new Error(`Unexpected fixture path: ${path}`);
  };
  vm.runInNewContext(readFileSync(new URL("../apps/miniapp/pages/booking/index.js", import.meta.url), "utf8"), {
    exports: {},
    Error,
    Page(definition) {
      page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
    },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      showToast: (value) => toasts.push(value), showModal: (value) => modals.push(value), redirectTo() {},
    },
    require(name) {
      if (name === "../../utils/booking") return booking;
      if (name === "../../utils/friend-payment") return require("../apps/miniapp/utils/friend-payment.js");
      if (name === "../../utils/api") return { ApiError, api, money: (amount) => (amount / 100).toFixed(2), shanghaiTime: (value) => value, newKey: () => nextKey++ === 1 ? "fixture-order-key" : `fixture-order-key-${nextKey - 1}` };
      if (name === "../../utils/auth") return {
        getStoredSession: () => ({ user: { phoneVerified: true } }), needsPhoneVerification: () => false,
        requireVerifiedCustomerAccess: () => true, goToPhoneVerification() {},
      };
      if (name === "../../utils/amap") return {};
      if (name === "../../utils/customer-center") return { customerCenterPath: (path) => `${path}?organizationId=org-fixture` };
      throw new Error(`Unexpected compiled dependency: ${name}`);
    },
  });
  Object.assign(page.data, {
    service: { id: "service-fixture", slug: "french-spa", priceFen: 49800 }, quantity: 1,
    slots: [slot(1), slot(2)], selected: 0, contactName: "测试客户", phone: "13800138000",
    detail: "测试市测试路1号", doorNumber: "102", latitude: 34.7, longitude: 113.7,
    consent: true, phoneVerified: true, loggedIn: true,
  });
  return {
    page, calls, modals, toasts, timers,
    async tick() { const entries = [...timers.entries()]; timers.clear(); for (const [, callback] of entries) callback(); await new Promise((done) => setImmediate(done)); },
  };
}

test("coupon thresholds, status and valid dates explain which coupons are unavailable", () => {
  const rows = booking.bookingCouponRows([
    ...coupons,
    coupon("used", 1000, 19800, { status: "USED" }),
    coupon("expired", 1000, 19800, { expiresAt: "2026-10-01T00:00:00Z" }),
    coupon("future", 1000, 19800, { validFrom: "2098-01-01T00:00:00Z" }),
  ], 29800, now);
  assert.deepEqual(rows.map((row) => row.eligible), [false, false, true, true, false, false, false]);
  assert.match(rows[0].reason, /498\.00/);
  assert.match(rows[2].scope, /仅抵项目费/);
  assert.equal(rows[4].reason, "已使用"); assert.equal(rows[5].reason, "已过期"); assert.equal(rows[6].reason, "尚未到使用时间");
});

test("the server quote must match the hold, integer amounts and the free-travel promise", () => {
  assert.doesNotThrow(() => booking.assertServerQuote(quote("hold-1"), "hold-1"));
  for (const invalid of [quote("foreign-hold"), { ...quote("hold-1"), payableFen: 49800 },
    { ...quote("hold-1"), discountFen: -1 }, { ...quote("hold-1"), payableFen: NaN },
    { ...quote("hold-1"), travelFeeFen: 100, payableFen: 45900 }]) {
    assert.throws(() => booking.assertServerQuote(invalid, "hold-1"));
  }
});

test("default quote uses the backend best coupon; explicit opt-out requests null", async () => {
  const f = fixture();
  await f.page.loadCoupons();
  assert.equal(await f.page.refreshQuote(), true);
  assert.equal(f.page.data.quoteDetails.payable, "458.00");
  assert.equal(f.page.data.quoteCouponId, "coupon40");
  assert.equal(Object.hasOwn(f.calls.find((call) => call.path === "/orders/quote").data, "couponId"), false);
  f.page.chooseCoupon({ currentTarget: { dataset: { id: "none" } } });
  assert.equal(f.page.data.quoteDetails, null);
  await f.tick();
  assert.equal(f.page.data.quoteDetails.payable, "498.00");
  assert.equal(f.calls.filter((call) => call.path === "/booking-holds").length, 1);
  assert.equal(f.calls.filter((call) => call.path === "/orders/quote").at(-1).data.couponId, null);
});

test("an older quote cannot restore its amount after the customer changes coupon selection", async () => {
  const gate = defer(); let first = true;
  const f = fixture(async (path, data) => { if (path === "/orders/quote" && first) { first = false; await gate.promise; return quote(data.reservationId); } });
  const pending = f.page.refreshQuote();
  await new Promise((done) => setImmediate(done));
  f.page.chooseCoupon({ currentTarget: { dataset: { id: "none" } } });
  gate.resolve(); await pending;
  assert.equal(f.page.data.quoteDetails, null);
  await f.tick();
  assert.equal(f.page.data.quoteDetails.payable, "498.00");
});

test("address changes invalidate the quote immediately and reuse only the same real slot hold", async () => {
  const f = fixture(); await f.page.refreshQuote();
  f.page.input({ currentTarget: { dataset: { field: "doorNumber" } }, detail: { value: "103" } });
  assert.equal(f.page.data.quoteDetails, null);
  assert.equal(f.page.data.quoteFingerprint, "");
  await f.tick();
  assert.match(f.page.data.quoteFingerprint, /103/);
  assert.equal(f.calls.filter((call) => call.path === "/booking-holds").length, 1);
});

test("changing the appointment releases the old real hold before taking the new slot", async () => {
  const f = fixture(); await f.page.refreshQuote();
  f.page.select({ currentTarget: { dataset: { index: 1 } } });
  await f.tick();
  const capacityCalls = f.calls.filter((call) => call.path.startsWith("/booking-holds"));
  assert.deepEqual(capacityCalls.map((call) => call.path), ["/booking-holds", "/booking-holds/hold-1/release", "/booking-holds"]);
  assert.equal(capacityCalls.at(-1).data.therapistId, "tech-2");
  assert.equal(f.page.data.quoteCouponId, "coupon40");
});

test("an unavailable coupon cannot be selected or sent in a quote request", async () => {
  const f = fixture();
  f.page.data.service.priceFen = 29800;
  await f.page.loadCoupons();
  f.page.chooseCoupon({ currentTarget: { dataset: { id: "coupon40" } } });
  assert.equal(f.page.data.couponChoice, "auto");
  assert.equal(f.calls.some((call) => call.path === "/orders/quote"), false);
});

test("changed server order amounts never trigger payment even after a valid quote", async () => {
  const f = fixture((path, data) => path === "/orders" ? {
    id: "unexpected-order", status: "PENDING_PAYMENT", ...quote(data.reservationId, 0, null),
  } : undefined);
  let paid = false;
  f.page.payCreatedOrder = async () => { paid = true; };
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(paid, false);
  assert.equal(f.modals.at(-1).title, "订单价格异常");
});

test("late capacity replies after page unload are released, not used for order creation", async () => {
  const gate = defer();
  const f = fixture(async (path, data) => { if (path === "/booking-holds") {
    await gate.promise;
    return { id: "late-hold", ...data, expiresAt: "2099-01-01T00:00:00Z", status: "HOLD" };
  } });
  const pending = f.page.refreshQuote();
  await new Promise((done) => setImmediate(done));
  f.page.onUnload(); gate.resolve(); await pending;
  assert.equal(f.calls.some((call) => call.path === "/booking-holds/late-hold/release"), true);
  assert.equal(f.calls.some((call) => call.path === "/orders/quote" || call.path === "/orders"), false);
});

test("missing or failed server quotes never fall back to a catalog payable amount or order creation", async () => {
  const f = fixture((path) => { if (path === "/orders/quote") throw new Error("服务端报价暂不可用"); });
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(f.page.data.quoteDetails, null); assert.match(f.page.data.error, /报价暂不可用/);
  assert.equal(f.calls.some((call) => call.path === "/orders"), false);
});

test("order creation first verifies the address, refreshes quote and preserves the server coupon", async () => {
  const f = fixture(); f.page.data.addressVerificationRequired = true;
  f.page.payCreatedOrder = async () => undefined;
  await f.page.refreshQuote(); await f.page.create();
  const create = f.calls.find((call) => call.path === "/orders");
  assert.equal(create.data.couponId, "coupon40"); assert.equal(create.data.addressVerificationId, "verified-address");
  assert.equal(create.key, "fixture-order-key");
  assert.equal(f.calls.filter((call) => call.path === "/orders/quote").length, 2);
});

test("a newly changed server discount requires another explicit submission before an order is created", async () => {
  let count = 0;
  const f = fixture((path, data) => path === "/orders/quote" ? quote(data.reservationId, ++count > 1 ? 3000 : 4000, count > 1 ? "coupon30" : "coupon40") : undefined);
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(f.page.data.quoteDetails.payable, "468.00");
  assert.equal(f.calls.some((call) => call.path === "/orders"), false);
  assert.match(f.toasts.at(-1).title, /价格已更新/);
});

test("a retry after an uncertain create result keeps identical immutable address and coupon", async () => {
  const f = fixture((path) => { if (path === "/orders") throw new Error("Synthetic uncertain network result"); });
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(f.page.data.orderSubmissionAttempted, true);
  f.page.input({ currentTarget: { dataset: { field: "doorNumber" } }, detail: { value: "999" } });
  f.page.chooseCoupon({ currentTarget: { dataset: { id: "none" } } });
  await f.page.create();
  const creates = f.calls.filter((call) => call.path === "/orders");
  assert.equal(creates.length, 2); assert.deepEqual(creates[0], creates[1]);
  assert.equal(f.calls.filter((call) => call.path === "/orders/quote").length, 2);
});

test("a definite coupon rejection unlocks editing and requires a fresh quote and idempotency key", async () => {
  let creates = 0;
  const f = fixture((path) => {
    if (path === "/orders" && ++creates === 1) throw new ApiError("优惠券状态已变化，请重新获取报价", 409, "/orders", "POST");
  });
  await f.page.refreshQuote(); await f.page.create();
  const rejected = f.calls.find((call) => call.path === "/orders");
  assert.equal(f.page.data.orderSubmissionAttempted, false);
  assert.equal(f.page.data.quoteDetails, null); assert.equal(f.page.data.quoteFingerprint, "");
  assert.notEqual(f.page.data.orderKey, rejected.key);
  f.page.input({ currentTarget: { dataset: { field: "doorNumber" } }, detail: { value: "103" } });
  f.page.chooseCoupon({ currentTarget: { dataset: { id: "none" } } });
  assert.equal(f.page.data.doorNumber, "103"); assert.equal(f.page.data.couponChoice, "none");
  await f.page.create();
  assert.equal(f.calls.filter((call) => call.path === "/orders").length, 1, "an invalidated quote cannot immediately create a replacement order");
  assert.equal(f.calls.filter((call) => call.path === "/orders/quote").at(-1).data.couponId, null);
  assert.equal(f.page.data.quoteDetails.payable, "498.00");
});

test("a definite expired hold discards that hold and takes a fresh real reservation", async () => {
  const f = fixture((path) => { if (path === "/orders") throw new ApiError("预约占位已过期", 409, "/orders", "POST"); });
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(f.page.data.orderSubmissionAttempted, false); assert.equal(f.page.data.reservationId, "");
  assert.equal(f.page.data.reservationSlotKey, ""); assert.equal(f.page.data.reservationExpiresAt, "");
  await f.page.prepareOrder();
  assert.equal(f.page.data.reservationId, "hold-2");
  assert.equal(f.calls.filter((call) => call.path === "/booking-holds").length, 2);
});

test("a definite address rejection invalidates its verification and mandates server verification again", async () => {
  const f = fixture((path) => { if (path === "/orders") throw new ApiError("服务地址核验已失效，请重新核验", 422, "/orders", "POST"); });
  await f.page.refreshQuote(); await f.page.create();
  assert.equal(f.page.data.orderSubmissionAttempted, false); assert.equal(f.page.data.addressVerificationId, "");
  assert.equal(f.page.data.addressVerificationRequired, true);
  await f.page.prepareOrder();
  assert.equal(f.page.data.addressVerificationId, "verified-address");
  assert.equal(f.calls.filter((call) => call.path === "/locations/address-verifications").length, 1);
});

test("existing-order conflicts, unknown 4xx and 5xx never unlock an uncertain submission", async () => {
  for (const error of [
    new ApiError("预约占位已经生成订单", 409, "/orders", "POST"),
    new ApiError("幂等键已用于不同的下单请求", 409, "/orders", "POST"),
    new ApiError("未知冲突", 409, "/orders", "POST"),
    new ApiError("下单参数或幂等键无效", 400, "/orders", "POST"),
    new ApiError("请先登录", 401, "/orders", "POST"),
    new ApiError("请先完成微信手机号验证", 403, "/orders", "POST"),
    new ApiError("优惠券状态已变化，请重新获取报价", 500, "/orders", "POST"),
    new ApiError("优惠券状态已变化，请重新获取报价", 409, "/orders/quote", "POST"),
    new ApiError("优惠券状态已变化，请重新获取报价", 409, "/orders", "GET"),
  ]) {
    const f = fixture((path) => { if (path === "/orders") throw error; });
    await f.page.refreshQuote(); await f.page.create();
    assert.equal(f.page.data.orderSubmissionAttempted, true, `${error.statusCode}:${error.message}`);
    f.page.chooseCoupon({ currentTarget: { dataset: { id: "none" } } });
    assert.equal(f.page.data.couponChoice, "auto");
    await f.page.create();
    const creates = f.calls.filter((call) => call.path === "/orders");
    assert.deepEqual(creates[0], creates[1]);
  }
});

test("a known rejection after an earlier unknown result still preserves the original request", async () => {
  for (const initial of [new Error("network outcome unknown"), new ApiError("服务器内部错误", 503, "/orders", "POST")]) {
    let creates = 0;
    const f = fixture((path) => {
      if (path === "/orders") throw ++creates === 1 ? initial : new ApiError("优惠券状态已变化，请重新获取报价", 409, "/orders", "POST");
    });
    await f.page.refreshQuote(); await f.page.create(); await f.page.create();
    assert.equal(f.page.data.orderSubmissionAttempted, true);
    const calls = f.calls.filter((call) => call.path === "/orders");
    assert.deepEqual(calls[0], calls[1]);
  }
});

test("booking view has real coupon selection and never presents the catalog price as a final payable", () => {
  const view = readFileSync(new URL("../apps/miniapp/pages/booking/index.wxml", import.meta.url), "utf8");
  assert.match(view, /选择优惠券/); assert.match(view, /item\.reason/); assert.match(view, /最终实付/);
  assert.doesNotMatch(view, /待优惠模块接入|待核价|quoteDetails\.payable:price/);
});

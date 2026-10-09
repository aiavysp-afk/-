import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const order = {
  id: "fixture-order",
  orderNo: "FIXTURE_ORDER_001",
  reservationId: "fixture-hold",
  status: "PENDING_PAYMENT",
  serviceName: "Synthetic service",
  appointmentStart: "2099-01-01T01:00:00.000Z",
  appointmentEnd: "2099-01-01T02:00:00.000Z",
  serviceAmountFen: 199,
  travelFeeFen: 0,
  discountFen: 0,
  payableFen: 199,
  paymentExpiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2098-12-31T00:00:00.000Z",
};
const session = {
  accessToken: "synthetic-fixture-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: {
    id: "fixture-customer",
    displayName: "Fixture",
    phoneVerified: true,
    memberships: [],
  },
};
const parameters = {
  timeStamp: "1791091200",
  nonceStr: "fixture-nonce",
  package: "prepay_id=fixture_123",
  signType: "RSA",
  paySign: "synthetic-fixture-only-not-a-signature",
};
const wechatIntent = {
  id: "PAY_fixture",
  orderId: order.id,
  provider: "WECHAT",
  status: "PENDING",
  amountFen: order.payableFen,
  expiresAt: order.paymentExpiresAt,
  mockConfirmationAvailable: false,
  prepayState: "READY",
  wechatPayParameters: parameters,
};
const mockIntent = {
  ...wechatIntent,
  provider: "MOCK",
  prepayState: "NONE",
  wechatPayParameters: undefined,
  mockConfirmationAvailable: true,
};
const event = (id = order.id) => ({
  currentTarget: { dataset: { id, action: "pay" } },
});

async function fixture({
  intent = wechatIntent,
  modal = "confirm",
  sdk = "success",
  reconcile = { status: "PENDING" },
  reconcileFails = false,
  serverOrders = [order],
  intentGate,
} = {}) {
  const apiCalls = [],
    modals = [],
    sdkCalls = [],
    toasts = [],
    sequence = [];
  async function api(path, method = "GET", data) {
    apiCalls.push({ path, method, data });
    sequence.push(`api:${path}`);
    if (path === `/orders/${order.id}/payment-intent`) {
      assert.equal(method, "POST");
      if (intentGate) await intentGate;
      return structuredClone(intent);
    }
    if (/^\/payments\/[A-Za-z0-9_-]+\/reconcile$/.test(path)) {
      assert.equal(method, "POST");
      if (reconcileFails) throw new Error("Synthetic query unavailable");
      return structuredClone(reconcile);
    }
    if (path === "/orders") {
      assert.equal(method, "GET");
      return structuredClone(serverOrders);
    }
    if (path === `/orders/${order.id}/refunds`) return [];
    if (path === `/orders/${order.id}/safety-incidents`) return [];
    if (path === `/dev/payments/${mockIntent.id}/succeed`) {
      assert.equal(method, "POST");
      return { status: "SUCCEEDED" };
    }
    throw new Error("Unexpected synthetic API path");
  }
  const wx = {
    showModal(input) {
      modals.push(input);
      sequence.push("modal");
      if (modal === "fail") input.fail();
      else
        input.success({
          confirm: modal === "confirm",
          cancel: modal !== "confirm",
        });
    },
    requestPayment(input) {
      sdkCalls.push(input);
      sequence.push("sdk");
      if (sdk === "success") input.success();
      else
        input.fail({
          errMsg:
            sdk === "cancel"
              ? "requestPayment:fail cancel"
              : "requestPayment:fail synthetic",
        });
    },
    showToast(input) {
      toasts.push(input);
    },
    getStorageSync() {
      return undefined;
    },
    setStorageSync() {},
    removeStorageSync() {},
  };
  let definition;
  vm.runInNewContext(
    await readFile(
      new URL("../apps/miniapp/pages/orders/index.js", import.meta.url),
      "utf8",
    ),
    {
      exports: {},
      wx,
      Page(input) {
        definition = input;
      },
      require(name) {
        if (name === "../../utils/friend-payment") return require("../apps/miniapp/utils/friend-payment.js");
        if (name === "../../utils/api")
          return {
            api,
            money: (fen) => (fen / 100).toFixed(2),
            shanghaiTime: () => "Synthetic appointment time",
            newKey: () => "synthetic-idempotency-key",
          };
        if (name === "../../utils/auth")
          return {
            getStoredSession: () => session,
            loginWithWechat: async () => session,
            needsPhoneVerification: () => false,
            goToPhoneVerification() {},
          };
        if (name === "../../utils/tab-bar")
          return { syncCustomTabBar() {} };
        throw new Error("Unexpected compiled page dependency");
      },
    },
    { filename: "compiled-orders-fixture.js" },
  );
  const page = {
    ...definition,
    data: {
      ...structuredClone(definition.data),
      loggedIn: true,
      orders: [
        {
          ...structuredClone(order),
          price: "1.99",
          time: "Fixture",
          refunds: [],
          refundAvailable: false,
        },
      ],
    },
    setData(values) {
      Object.assign(this.data, values);
    },
  };
  const count = (suffix) =>
    apiCalls.filter((call) => call.path.endsWith(suffix)).length;
  return { page, apiCalls, modals, sdkCalls, toasts, sequence, count };
}

test("orders pay button neutrally requests channel confirmation, never promises a real SDK will not debit", async () => {
  const wxml = await readFile(
    new URL("../apps/miniapp/pages/orders/index.wxml", import.meta.url),
    "utf8",
  );
  assert.match(wxml, /查看支付渠道并确认/);
  assert.doesNotMatch(wxml, />\s*模拟支付（不会扣款）\s*</);
});

test("WECHAT READY intent requires a real-funds modal before exactly one SDK call and original-query reconciliation", async () => {
  const f = await fixture();
  assert.equal(f.sdkCalls.length, 0);
  await f.page.action(event());
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].title, "确认微信真实支付");
  assert.match(f.modals[0].content, /¥1\.99/);
  assert.match(f.modals[0].content, /真实付款/);
  assert.match(f.modals[0].content, /取消不会调起微信支付/);
  assert.equal(f.sdkCalls.length, 1);
  assert.ok(f.sequence.indexOf("modal") < f.sequence.indexOf("sdk"));
  for (const key of Object.keys(parameters))
    assert.equal(f.sdkCalls[0][key], parameters[key]);
  assert.equal(f.count("/payment-intent"), 1);
  assert.equal(f.count("/reconcile"), 1);
  assert.equal(f.count("/succeed"), 0);
  assert.equal(f.page.data.busy, "");
});

for (const modal of ["cancel", "fail"]) {
  test(`WECHAT real-funds modal ${modal} never invokes SDK or Mock confirmation`, async () => {
    const f = await fixture({ modal });
    await f.page.action(event());
    assert.equal(f.modals.length, 1);
    assert.equal(f.sdkCalls.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.count("/payment-intent"), 1);
    assert.equal(f.page.data.orders[0].status, "PENDING_PAYMENT");
    assert.equal(f.page.data.busy, "");
  });
}

test("MOCK PENDING + boolean true + explicit modal confirmation alone can call the synthetic success endpoint", async () => {
  const f = await fixture({ intent: mockIntent });
  await f.page.action(event());
  assert.equal(f.modals.length, 1);
  assert.match(f.modals[0].title, /模拟/);
  assert.match(f.modals[0].content, /不会扣除/);
  assert.equal(f.count("/succeed"), 1);
  assert.ok(
    f.sequence.indexOf("modal") <
      f.sequence.indexOf(`api:/dev/payments/${mockIntent.id}/succeed`),
  );
  assert.equal(f.sdkCalls.length, 0);
  assert.equal(f.count("/reconcile"), 0);
});

for (const modal of ["cancel", "fail"]) {
  test(`MOCK modal ${modal} cannot confirm synthetic payment`, async () => {
    const f = await fixture({ intent: mockIntent, modal });
    await f.page.action(event());
    assert.equal(f.modals.length, 1);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.sdkCalls.length, 0);
  });
}

test("false/missing/string/numeric Mock confirmation flags fail closed instead of relying on truthiness", async () => {
  for (const flag of [false, undefined, "true", "false", 1]) {
    const f = await fixture({
      intent: { ...mockIntent, mockConfirmationAvailable: flag },
    });
    await f.page.action(event());
    assert.equal(f.modals.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.sdkCalls.length, 0);
    assert.ok(f.page.data.error);
  }
});

test("nonpending Mock intents cannot expose a synthetic success confirmation", async () => {
  for (const status of [
    "SUCCEEDED",
    "CLOSED",
    "FAILED",
    "REFUNDING",
    "REFUNDED",
    "UNKNOWN",
  ]) {
    const f = await fixture({ intent: { ...mockIntent, status } });
    await f.page.action(event());
    assert.equal(f.modals.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.sdkCalls.length, 0);
    assert.ok(f.page.data.error);
  }
});

test("unknown providers cannot fall through to Mock even when the Mock availability flag is true", async () => {
  for (const provider of ["UNKNOWN", "wechat", "mock", "", undefined]) {
    const f = await fixture({ intent: { ...mockIntent, provider } });
    await f.page.action(event());
    assert.equal(f.modals.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.sdkCalls.length, 0);
    assert.ok(f.page.data.error);
  }
});

test("only a currently loaded PENDING_PAYMENT order can start preparing a payment", async () => {
  const missing = await fixture();
  await missing.page.action(event("not-a-loaded-order"));
  assert.equal(missing.count("/payment-intent"), 0);
  assert.equal(missing.sdkCalls.length, 0);
  assert.equal(missing.modals.length, 0);
  const paid = await fixture();
  paid.page.data.orders[0].status = "PAID";
  await paid.page.action(event());
  assert.equal(paid.count("/payment-intent"), 0);
  assert.equal(paid.sdkCalls.length, 0);
  assert.equal(paid.modals.length, 0);
});

test("unsafe payment IDs, wrong order and untrusted/mismatched amounts stop before any native action or confirmation", async () => {
  const variants = [
    null,
    { ...wechatIntent, id: "../../unsafe" },
    { ...wechatIntent, id: "" },
    { ...wechatIntent, id: "a".repeat(129) },
    { ...wechatIntent, orderId: "another-order" },
    { ...wechatIntent, amountFen: 200 },
    { ...wechatIntent, amountFen: "199" },
    { ...wechatIntent, amountFen: 199.5 },
    { ...wechatIntent, amountFen: 0 },
    { ...wechatIntent, amountFen: -1 },
    { ...wechatIntent, amountFen: NaN },
    { ...wechatIntent, amountFen: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const intent of variants) {
    const f = await fixture({ intent });
    await f.page.action(event());
    assert.equal(f.modals.length, 0);
    assert.equal(f.sdkCalls.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.count("/reconcile"), 0);
    assert.ok(f.page.data.error);
    assert.equal(f.page.data.busy, "");
  }
});

test("WECHAT missing/unknown/not-ready prepay results query the original payment and never open SDK or create a second intent", async () => {
  const variants = [
    { ...wechatIntent, wechatPayParameters: undefined },
    { ...wechatIntent, status: "FAILED" },
    { ...wechatIntent, prepayState: undefined },
    { ...wechatIntent, prepayState: "UNKNOWN" },
    { ...wechatIntent, prepayState: "DISPATCHING" },
    { ...wechatIntent, prepayState: "NONE" },
    { ...wechatIntent, prepayState: "UNKNOWN", wechatPayParameters: undefined },
    {
      ...wechatIntent,
      prepayState: "DISPATCHING",
      wechatPayParameters: undefined,
    },
  ];
  for (const intent of variants) {
    const f = await fixture({ intent });
    await f.page.action(event());
    assert.equal(f.modals.length, 0);
    assert.equal(f.sdkCalls.length, 0);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.count("/payment-intent"), 1);
    assert.equal(f.count("/reconcile"), 1);
    assert.equal(
      f.apiCalls.find((call) => call.path.endsWith("/reconcile")).path,
      `/payments/${wechatIntent.id}/reconcile`,
    );
    assert.equal(f.page.data.orders[0].status, "PENDING_PAYMENT");
    assert.ok(f.page.data.error);
  }
});

test("verified successful original query refreshes authoritative order without SDK or a new payment", async () => {
  const f = await fixture({
    intent: { ...wechatIntent, wechatPayParameters: undefined },
    reconcile: { status: "SUCCEEDED" },
    serverOrders: [{ ...order, status: "PAID" }],
  });
  await f.page.action(event());
  assert.equal(f.sdkCalls.length, 0);
  assert.equal(f.count("/payment-intent"), 1);
  assert.equal(f.count("/reconcile"), 1);
  assert.equal(f.count("/succeed"), 0);
  assert.equal(f.page.data.orders[0].status, "PAID");
});

test("SDK success with unconfirmed server query never locally marks the order PAID or announces payment success", async () => {
  const f = await fixture({ sdk: "success", reconcile: { status: "PENDING" } });
  await f.page.action(event());
  assert.equal(f.sdkCalls.length, 1);
  assert.equal(f.count("/reconcile"), 1);
  assert.equal(f.count("/succeed"), 0);
  assert.equal(f.page.data.orders[0].status, "PENDING_PAYMENT");
  assert.ok(f.toasts.every((toast) => !/支付成功|已经到账/.test(toast.title)));
});

for (const sdk of ["cancel", "failure"]) {
  test(`SDK ${sdk} still queries the original payment and does not invent settlement or confirm Mock`, async () => {
    const f = await fixture({ sdk });
    await f.page.action(event());
    assert.equal(f.sdkCalls.length, 1);
    assert.equal(f.count("/reconcile"), 1);
    assert.equal(f.count("/succeed"), 0);
    assert.equal(f.page.data.orders[0].status, "PENDING_PAYMENT");
    assert.ok(
      f.toasts.some((toast) =>
        sdk === "cancel"
          ? /已取消支付/.test(toast.title)
          : /待确认/.test(toast.title),
      ),
    );
    assert.ok(
      f.toasts.every((toast) => !/支付成功|已经到账/.test(toast.title)),
    );
  });
}

test("query failure after native SDK success is honestly pending confirmation and never retried as a new payment", async () => {
  const f = await fixture({ sdk: "success", reconcileFails: true });
  await f.page.action(event());
  assert.equal(f.sdkCalls.length, 1);
  assert.equal(f.count("/payment-intent"), 1);
  assert.equal(f.count("/reconcile"), 1);
  assert.equal(f.count("/succeed"), 0);
  assert.equal(f.page.data.orders[0].status, "PENDING_PAYMENT");
  assert.ok(f.toasts.some((toast) => /待确认/.test(toast.title)));
});

test("busy suppresses a concurrent second click while payment preparation is unresolved", async () => {
  let release;
  const intentGate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ intent: mockIntent, modal: "cancel", intentGate });
  const first = f.page.action(event());
  assert.equal(f.page.data.busy, order.id);
  await f.page.action(event());
  assert.equal(f.count("/payment-intent"), 1);
  release();
  await first;
  assert.equal(f.modals.length, 1);
  assert.equal(f.sdkCalls.length, 0);
  assert.equal(f.count("/succeed"), 0);
  assert.equal(f.page.data.busy, "");
});

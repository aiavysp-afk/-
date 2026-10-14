import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function fixture(pageName, { allowOrder = false } = {}) {
  let page;
  const calls = [],
    routes = [],
    notices = [];
  const source = readFileSync(
    new URL(`../apps/miniapp/pages/${pageName}/index.ts`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: {},
    Date,
    Error,
    Promise,
    encodeURIComponent,
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(values) {
          Object.assign(this.data, values);
        },
      };
    },
    require(name) {
      if (name === "../../utils/auth")
        return {
          getStoredSession: () => ({
            loginMethod: "PHONE_SMS",
            user: { phoneVerified: true },
          }),
          requireVerifiedCustomerAccess: () => true,
          needsPhoneVerification: () => false,
          goToPhoneVerification: () =>
            routes.push("/pages/phone-verification/index?forceChoice=1"),
        };
      if (name === "../../utils/api")
        return {
          api: async (...args) => {
            calls.push(args);
            if (allowOrder && args[0] === "/orders")
              return {
                id: "owned-order",
                status: "PENDING_PAYMENT",
                serviceAmountFen: 21800,
                travelFeeFen: 0,
                discountFen: 0,
                payableFen: 21800,
              };
            throw new Error("Payment must not start under SMS identity");
          },
          money: (fen) => (fen / 100).toFixed(2),
        };
      return {};
    },
    wx: {
      showToast: (value) => notices.push(value),
      redirectTo: (value) => routes.push(value.url),
      showModal: () =>
        assert.fail(
          "Must not ask for a financial confirmation before WeChat identity",
        ),
      requestPayment: () =>
        assert.fail("Must not call WeChat payment under an SMS session"),
    },
  });
  return { page, calls, routes, notices };
}
test("SMS customer's created booking remains pending and opens an explicit WeChat login choice", async () => {
  const h = fixture("booking");
  const order = {
    id: "owned-order",
    status: "PENDING_PAYMENT",
    payableFen: 21800,
  };
  assert.equal(await h.page.payCreatedOrder(order), false);
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.routes, ["/pages/phone-verification/index?forceChoice=1"]);
  assert.match(h.notices[0].title, /订单已保存/);
});
test("booking creation cannot overwrite the SMS-to-WeChat choice with an orders redirect", async () => {
  const h = fixture("booking", { allowOrder: true });
  Object.assign(h.page.data, {
    quoteDetails: {
      serviceAmount: "218.00",
      discount: "0.00",
      payable: "218.00",
    },
    quoteFingerprint: "same-draft",
    reservationId: "owned-hold",
    orderKey: "original-key",
    paymentMode: "WECHAT",
  });
  h.page.prepareOrder = async () => undefined;
  h.page.draftFingerprint = () => "same-draft";
  h.page.validDraft = () => true;
  h.page.fullAddress = () => "isolated fixture only";
  await h.page.create();
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ["/orders"],
  );
  assert.deepEqual(h.routes, ["/pages/phone-verification/index?forceChoice=1"]);
  assert.equal(h.page.data.busy, false);
});
test("SMS order payment changes no record, creates no second intent and offers WeChat login", async () => {
  const h = fixture("orders");
  h.page.data.orders = [
    { id: "owned-order", status: "PENDING_PAYMENT", payableFen: 21800 },
  ];
  await h.page.action({
    currentTarget: { dataset: { id: "owned-order", action: "pay" } },
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.data.orders[0].status, "PENDING_PAYMENT");
  assert.deepEqual(h.routes, ["/pages/phone-verification/index?forceChoice=1"]);
  assert.equal(h.page.data.busy, "");
});
test("SMS wallet recharge redirects before financial confirmation or provider preparation", async () => {
  const h = fixture("stored-value");
  h.page.data.rechargeEnabled = true;
  h.page.data.balance = "376.00";
  await h.page.confirmRecharge();
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.data.balance, "376.00");
  assert.deepEqual(h.routes, ["/pages/phone-verification/index?forceChoice=1"]);
});

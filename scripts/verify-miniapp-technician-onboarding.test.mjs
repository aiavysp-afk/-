import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = (path) =>
  readFileSync(new URL(`../apps/miniapp/${path}`, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
function fixture(path, handler, verified = true) {
  let page;
  const calls = [],
    routes = [],
    guards = [];
  vm.runInNewContext(compile(path), {
    exports: {},
    Error,
    Promise,
    Date,
    Number,
    String,
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(value) {
          Object.assign(this.data, value);
        },
      };
    },
    require(name) {
      if (name === "../../utils/api")
        return {
          api: async (endpoint, method = "GET", data) => {
            calls.push({ endpoint, method, data });
            return handler(endpoint, method, data);
          },
        };
      if (name === "../../utils/auth")
        return {
          getStoredSession: () =>
            verified
              ? {
                  accessToken: "fixture-wechat-token",
                  loginMethod: "WECHAT",
                  user: { phoneVerified: true },
                }
              : undefined,
          getCustomerLoginCapabilities: async () => ({
            wechatPhoneLoginEnabled: true,
          }),
          clearStoredSession() {},
          requireVerifiedCustomerAccess: (returnPath) => {
            guards.push(returnPath);
            return verified;
          },
        };
      throw new Error(name);
    },
    wx: {
      request(input) {
        const endpoint = "/technician/onboarding";
        calls.push({ endpoint, method: input.method, data: input.data });
        Promise.resolve(handler(endpoint, input.method, input.data)).then(
          (data) => input.success({ statusCode: 200, data: { data } }),
        );
      },
      redirectTo: (value) => routes.push(value.url),
      navigateTo: (value) => routes.push(value.url),
      showModal: (value) => value.success({ confirm: true }),
    },
    getApp: () => ({
      globalData: { apiBaseUrl: "https://fixture.invalid/v1" },
    }),
  });
  return { page, calls, routes, guards };
}
test("unverified applicant stays at the technician WeChat authorization page without creating a draft", async () => {
  const f = fixture("pages/technician-onboarding/index.ts", () => null, false);
  await f.page.onShow();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.guards, []);
  assert.equal(f.page.data.authenticated, false);
});
test("first registration creates an empty owner draft without invitation or pairing payload", async () => {
  const f = fixture(
    "pages/technician-onboarding/index.ts",
    (_path, method) => ({
      profile: method === "POST" ? { status: "DRAFT" } : null,
      canEnterWorkbench: false,
      phoneVerified: true,
    }),
  );
  await f.page.onShow();
  assert.deepEqual(
    f.calls.map(({ endpoint, method }) => [endpoint, method]),
    [
      ["/technician/onboarding", "GET"],
      ["/technician/onboarding", "POST"],
    ],
  );
  assert.deepEqual(Object.keys(f.calls[1].data), []);
  assert.deepEqual(f.routes, ["/pages/technician-application/index"]);
  assert.equal(f.page.data.statusLabel, "填写入驻资料");
  f.page.editProfile();
  assert.deepEqual(f.routes, [
    "/pages/technician-application/index",
    "/pages/technician-application/index",
  ]);
});
test("pending stays on review, rejected resumes form and approved login directly opens workbench", async () => {
  for (const status of ["PENDING_REVIEW", "REJECTED", "APPROVED"]) {
    const f = fixture("pages/technician-onboarding/index.ts", () => ({
      profile: { status },
      canEnterWorkbench: status === "APPROVED",
      phoneVerified: true,
    }));
    await f.page.onShow();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      f.routes,
      status === "APPROVED"
        ? ["/pages/technician-workbench/index"]
        : status === "REJECTED"
          ? ["/pages/technician-application/index"]
          : [],
    );
  }
});
test("workbench must recheck approval and never query orders for a pending account", async () => {
  const f = fixture("pages/technician-workbench/index.ts", () => ({
    canEnterWorkbench: false,
  }));
  await f.page.onShow();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.routes, ["/pages/technician-onboarding/index"]);
});
test("native workbench uses server orders, labels and Beijing time for both shifts and appointments", async () => {
  const f = fixture("pages/technician-workbench/index.ts", (path) =>
    path.endsWith("onboarding")
      ? { canEnterWorkbench: true }
      : {
          orders: [
            {
              id: "order",
              status: "ASSIGNED",
              appointmentStart: "2026-10-12T02:00:00Z",
              payment: { kind: "FRIEND", status: "SUCCEEDED" },
            },
          ],
          shifts: [
            {
              id: "shift",
              startsAt: "2026-10-12T01:00:00Z",
              endsAt: "2026-10-12T10:00:00Z",
            },
          ],
        },
  );
  await f.page.onShow();
  assert.equal(f.page.data.orders[0].time, "2026-10-12 10:00");
  assert.equal(f.page.data.orders[0].statusLabel, "已指派");
  assert.equal(f.page.data.orders[0].paymentLabel, "已支付");
  assert.equal(f.page.data.shifts[0].startsLabel, "2026-10-12 09:00");
  await f.page.advance({
    currentTarget: { dataset: { id: "someone-else", action: "DEPART" } },
  });
  assert.equal(f.calls.filter(({ method }) => method === "POST").length, 0);
});
test("login return accepts only exact technician routes, not injected destinations", () => {
  const exports = {};
  vm.runInNewContext(compile("utils/login-return.ts"), {
    exports,
    require: () => ({ safeFriendPaymentReturnPath: () => "" }),
  });
  assert.equal(
    exports.safeLoginReturnPath("/pages/technician-onboarding/index"),
    "/pages/technician-onboarding/index",
  );
  assert.equal(
    exports.safeLoginReturnPath("/pages/technician-workbench/index"),
    "/pages/technician-workbench/index",
  );
  assert.equal(
    exports.safeLoginReturnPath(
      encodeURIComponent("/pages/technician-onboarding/index"),
    ),
    "/pages/technician-onboarding/index",
  );
  for (const path of [
    "https://evil.invalid",
    "/pages/technician-workbench/index?user=other",
    "/pages/admin/index",
    "//evil.invalid",
    "/pages/technician-photos/index",
  ])
    assert.equal(exports.safeLoginReturnPath(path), "");
  assert.doesNotMatch(
    source("pages/technician-onboarding/index.wxml"),
    /input|pairingCode|inviteCode/,
  );
});

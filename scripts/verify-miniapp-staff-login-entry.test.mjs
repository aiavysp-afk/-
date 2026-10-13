import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url),
  ts = require("typescript"),
  ENTRY = "/pages/admin-login/index";
const source = (path) =>
  readFileSync(new URL(`../apps/miniapp/${path}`, import.meta.url), "utf8");
function moduleExports(path, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(source(path), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    {
      exports,
      require(name) {
        if (dependencies[name]) return dependencies[name];
        throw new Error(name);
      },
    },
  );
  return exports;
}
const friendPayment = moduleExports("utils/friend-payment.ts");
const loginReturn = moduleExports("utils/login-return.ts", {
  "./friend-payment": friendPayment,
});
const session = (phoneVerified = true) => ({
  accessToken: "fixture-wechat-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: { id: "fixture-user", phoneVerified, memberships: [] },
});
function fixture(path, options = {}) {
  let page,
    stored = options.stored;
  const calls = [],
    routes = [],
    guards = [];
  const auth = {
    getStoredSession: () => stored,
    needsPhoneVerification: (value = stored) =>
      Boolean(value && value.user.phoneVerified !== true),
    loginWithWechat: async () => {
      calls.push("wechat-login");
      if (options.loginError) throw Error("微信授权未完成");
      stored = options.loginSession ?? session(false);
      return stored;
    },
    verifyWechatPhone: async () => {
      calls.push("wechat-phone");
      stored = { ...stored, user: { ...stored.user, phoneVerified: true } };
      return { maskedPhone: "138****8000" };
    },
    requireVerifiedCustomerAccess: (returnPath) => {
      guards.push(returnPath);
      return stored?.user.phoneVerified === true;
    },
  };
  vm.runInNewContext(
    ts.transpileModule(source(path), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    {
      exports: {},
      Error,
      Promise,
      Date,
      Number,
      String,
      setInterval,
      clearInterval,
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
        if (name === "../../utils/auth") return auth;
        if (name === "../../utils/login-return") return loginReturn;
        if (name === "../../utils/friend-payment") return friendPayment;
        if (name === "../../utils/api")
          return {
            api: async (...args) => {
              calls.push(args);
              if (options.apiError) throw Error(options.apiError);
              return { audience: "中原到家工作人员端", provider: "wechat" };
            },
          };
        throw new Error(name);
      },
      wx: {
        redirectTo: (value) => routes.push(value.url),
        switchTab: (value) => routes.push(value.url),
        navigateBack: () => routes.push("back"),
        showToast() {},
        showModal: (value) => value.success?.({ confirm: true }),
      },
    },
  );
  return { page, calls, routes, guards, stored: () => stored };
}

test("staff login return allows the exact local page and no pairing or approval parameters", () => {
  assert.equal(loginReturn.safeLoginReturnPath(ENTRY), ENTRY);
  assert.equal(loginReturn.safeLoginReturnPath(encodeURIComponent(ENTRY)), ENTRY);
  for (const path of [
    `${ENTRY}?pairCode=${"a".repeat(22)}`,
    `${ENTRY}?approved=1`,
    `${ENTRY}#approved`,
    `${ENTRY}/`,
    "/pages/admin-login/../admin/index",
    "/pages/admin/index",
    "https://evil.invalid/pages/admin-login/index",
    "//evil.invalid/pages/admin-login/index",
    encodeURIComponent(encodeURIComponent(ENTRY)),
    "%E0%A4%A",
  ])
    assert.equal(loginReturn.safeLoginReturnPath(path), "", path);
});

test("fresh WeChat identity still requires phone verification before returning to staff confirmation", async () => {
  const f = fixture("pages/phone-verification/index.ts");
  f.page.onLoad({ required: "1", returnPath: encodeURIComponent(ENTRY) });
  assert.equal(f.page.data.staffReturn, true);
  await f.page.authorizeWechat();
  assert.equal(f.page.data.wechatReady, true);
  assert.equal(f.page.data.completed, false);
  f.page.enterHome();
  f.page.finish();
  assert.deepEqual(f.routes, []);
  await f.page.authorizeWechatPhone({ detail: { code: "fixture-phone-code" } });
  assert.equal(f.stored().user.phoneVerified, true);
  assert.deepEqual(f.calls, ["wechat-login", "wechat-phone"]);
  assert.deepEqual(f.routes, [ENTRY]);
});

test("fresh WeChat login with an already verified phone returns to the exact staff page", async () => {
  const f = fixture("pages/phone-verification/index.ts", {
    loginSession: session(true),
  });
  f.page.onLoad({ required: "1", returnPath: ENTRY });
  await f.page.authorizeWechat();
  assert.equal(f.page.data.completed, true);
  assert.deepEqual(f.calls, ["wechat-login"]);
  assert.deepEqual(f.routes, [ENTRY]);
});

test("an already verified session returns without creating or approving any browser challenge", () => {
  const f = fixture("pages/phone-verification/index.ts", {
    stored: session(true),
  });
  f.page.onLoad({ required: "1", returnPath: ENTRY });
  assert.deepEqual(f.routes, [ENTRY]);
  assert.deepEqual(f.calls, []);
});

test("cancelled phone consent and denied WeChat login never return to staff confirmation", async () => {
  const f = fixture("pages/phone-verification/index.ts", {
    stored: session(false),
  });
  f.page.onLoad({ required: "1", returnPath: ENTRY });
  await f.page.authorizeWechatPhone({ detail: { errMsg: "getPhoneNumber:fail deny" } });
  assert.equal(f.page.data.completed, false);
  assert.deepEqual(f.routes, []);
  assert.deepEqual(f.calls, []);
  const denied = fixture("pages/phone-verification/index.ts", { loginError: true });
  denied.page.onLoad({ required: "1", returnPath: ENTRY });
  await denied.page.authorizeWechat();
  assert.equal(denied.page.data.completed, false);
  assert.deepEqual(denied.routes, []);
});

test("a completed UI flag cannot bypass the bound phone verification check", () => {
  const f = fixture("pages/phone-verification/index.ts", {
    stored: session(false),
  });
  f.page.onLoad({ required: "1", returnPath: ENTRY });
  f.page.setData({ completed: true });
  f.page.enterHome();
  f.page.finish();
  assert.deepEqual(f.routes, []);
});

test("staff page initial access and expired API sessions preserve the same exact return destination", async () => {
  const f = fixture("pages/admin-login/index.ts", {
    stored: session(true),
    loginSession: session(true),
  });
  f.page.onLoad();
  f.page.onPairInput({ detail: { value: "a".repeat(22) } });
  await f.page.inspect();
  assert.deepEqual(f.guards, [ENTRY, ENTRY]);
  const call = f.calls.find((value) => Array.isArray(value));
  assert.deepEqual(call.slice(0, 2), ["/auth/browser-login/inspect", "POST"]);
  assert.equal(call[4], ENTRY);
  f.page.onCodeInput({ detail: { value: "123456" } });
  await f.page.approve();
  assert.equal(f.calls.at(-1)[0], "/auth/browser-login/approve");
  assert.equal(f.calls.at(-1)[4], ENTRY);
});

test("staff confirmation rechecks phone status after fresh WeChat login", async () => {
  const f = fixture("pages/admin-login/index.ts", {
    stored: session(true),
    loginSession: session(false),
  });
  f.page.onPairInput({ detail: { value: "a".repeat(22) } });
  await f.page.inspect();
  assert.deepEqual(f.guards, [ENTRY]);
  assert.deepEqual(f.calls, ["wechat-login"]);
  assert.equal(f.page.data.preview, null);
  assert.equal(f.page.data.busy, false);
});

test("server non-staff denial cannot reveal a preview or auto-approve login", async () => {
  const f = fixture("pages/admin-login/index.ts", {
    stored: session(true),
    loginSession: session(true),
    apiError: "只有已授权工作人员可以登录后台",
  });
  f.page.onPairInput({ detail: { value: "a".repeat(22) } });
  await f.page.inspect();
  await f.page.approve();
  assert.equal(f.page.data.preview, null);
  assert.equal(f.page.data.approved, false);
  assert.match(f.page.data.error, /已授权工作人员/);
  assert.equal(f.calls.filter((value) => Array.isArray(value)).length, 1);
  assert.equal(f.calls.at(-1)[0], "/auth/browser-login/inspect");
});

test("opening the staff page with query arguments does not populate secrets or authorize anything", () => {
  const f = fixture("pages/admin-login/index.ts", { stored: session(true) });
  f.page.onLoad({ pairCode: "a".repeat(22), confirmationCode: "123456", approved: "1" });
  assert.equal(f.page.data.pairCode, "");
  assert.equal(f.page.data.confirmationCode, "");
  assert.equal(f.page.data.approved, false);
  assert.deepEqual(f.calls, []);
});

test("staff phone copy retains explicit consent, existing permission boundaries and manual device confirmation", () => {
  const markup = source("pages/phone-verification/index.wxml");
  assert.match(markup, /工作人员身份验证/);
  assert.match(markup, /不会新增管理权限，也不会自动确认配对/);
  assert.match(markup, /手机号需本人明确授权，不会自动读取/);
  assert.match(markup, /open-type="getPhoneNumber"/);
  assert.match(markup, /!technicianReturn && !staffReturn/);
});

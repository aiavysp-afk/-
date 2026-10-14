import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = (path) =>
  readFileSync(new URL(`../apps/miniapp/${path}`, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
function exportsOf(path, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(compile(path), {
    exports,
    require: (name) => dependencies[name],
  });
  return exports;
}
const friendPayment = exportsOf("utils/friend-payment.ts");
const loginReturn = exportsOf("utils/login-return.ts", {
  "./friend-payment": friendPayment,
});
const STAFF = "/pages/admin-login/index";
const TECHNICIAN = "/pages/technician-onboarding/index";
const FRIEND = `/pages/friend-payment/index?token=${"f".repeat(43)}`;
const session = (phoneVerified = true, loginMethod) => ({
  accessToken: "fixture-current-app-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: { id: "fixture-customer", phoneVerified, memberships: [] },
  ...(loginMethod ? { loginMethod } : {}),
});
function fixture(options = {}) {
  let page,
    stored = options.stored,
    timerId = 0;
  const calls = [],
    capabilitiesCalls = [],
    routes = [],
    timers = new Map();
  const auth = {
    getStoredSession: () => stored,
    needsPhoneVerification: (value = stored) =>
      Boolean(value && value.user.phoneVerified !== true),
    getCustomerLoginCapabilities: async () => {
      capabilitiesCalls.push("capabilities");
      if (options.capabilitiesHandler) return options.capabilitiesHandler();
      if (options.capabilitiesError) throw Error("服务异常");
      return (
        options.capabilities ?? {
          wechatPhoneLoginEnabled: true,
          smsLoginEnabled: true,
        }
      );
    },
    loginCustomerWithWechatPhone: async (...args) => {
      calls.push({ method: "atomic-wechat", args });
      if (options.loginPending) await options.loginPending;
      if (options.loginError) throw Error(options.loginError);
      stored = options.customerSession ?? session();
      return stored;
    },
    requestCustomerSmsLogin: async (...args) => {
      calls.push({ method: "sms-request", args });
      if (options.smsPending) await options.smsPending;
      if (options.smsError) throw Error(options.smsError);
      return {
        challengeId: "fixture-sms-challenge",
        expiresAt: "2099-01-01T00:05:00.000Z",
        retryAfterSeconds: 60,
        status: options.smsStatus ?? "SENT",
      };
    },
    confirmCustomerSmsLogin: async (...args) => {
      calls.push({ method: "sms-confirm", args });
      if (options.confirmError) throw Error(options.confirmError);
      stored = options.customerSession ?? session();
      return stored;
    },
    loginWithWechat: async () => {
      calls.push({ method: "wechat-identity" });
      if (options.loginError) throw Error(options.loginError);
      stored = options.wechatSession ?? session(false);
      return stored;
    },
    verifyWechatPhone: async (...args) => {
      calls.push({ method: "subject-phone", args });
      stored = { ...stored, user: { ...stored.user, phoneVerified: true } };
      return { maskedPhone: "138****8000" };
    },
  };
  vm.runInNewContext(compile("pages/phone-verification/index.ts"), {
    exports: {},
    Error,
    Date,
    Promise,
    Number,
    String,
    setInterval: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(update) {
          Object.assign(this.data, update);
        },
      };
    },
    require(name) {
      if (name === "../../utils/auth") return auth;
      if (name === "../../utils/friend-payment") return friendPayment;
      if (name === "../../utils/login-return") return loginReturn;
      throw Error(`Unexpected dependency: ${name}`);
    },
    wx: {
      showToast() {},
      navigateTo: ({ url }) => routes.push(url),
      redirectTo: ({ url }) => routes.push(url),
      switchTab: ({ url }) => routes.push(url),
      navigateBack: () => routes.push("back"),
    },
  });
  return {
    page,
    calls,
    capabilitiesCalls,
    routes,
    timers,
    stored: () => stored,
    async open(returnPath, pageOptions = {}) {
      page.onLoad({ required: "1", returnPath, ...pageOptions });
      await Promise.resolve();
      await Promise.resolve();
      await page.capabilitiesRequest;
    },
    tick() {
      for (const callback of timers.values()) callback();
    },
  };
}
const phoneConsent = {
  detail: { code: "fixture-native-phone-code", errMsg: "getPhoneNumber:ok" },
};
const agree = (f) => f.page.toggleAccepted();

test("agreements are initially unchecked and all three documents remain linked", async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.page.data.accepted, false);
  for (const type of ["user", "privacy", "service"])
    f.page.openAgreement({ currentTarget: { dataset: { type } } });
  assert.deepEqual(f.routes, [
    "/pages/agreement/index?type=user",
    "/pages/agreement/index?type=privacy",
    "/pages/agreement/index?type=service",
  ]);
  f.page.openAgreement({ currentTarget: { dataset: { type: "../../admin" } } });
  assert.equal(f.routes.length, 3);
});

test("unchecked agreements prevent every login and SMS send handler", async () => {
  const f = fixture();
  await f.open();
  f.page.handleWechatChoice();
  await f.page.authorizeWechatPhone(phoneConsent);
  await f.page.authorizeWechat();
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  await f.page.confirmSmsCode();
  assert.deepEqual(f.calls, []);
  assert.match(f.page.data.error, /请先阅读并同意/);
});

test("ordinary WeChat phone consent performs one atomic login and enters the homepage", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.calls, [
    { method: "atomic-wechat", args: ["fixture-native-phone-code", true] },
  ]);
  assert.equal(f.page.data.completed, true);
  assert.equal(f.stored().user.phoneVerified, true);
  assert.deepEqual(f.routes, ["/pages/home/index"]);
});

test("customer login never executes a legacy explicit WeChat first step", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  await f.page.authorizeWechat();
  assert.deepEqual(f.calls, []);
  assert.equal(f.page.data.completed, false);
});

test("cancelled or empty native phone consent starts no authentication request", async () => {
  for (const errMsg of [
    "getPhoneNumber:fail deny",
    "getPhoneNumber:fail cancel",
    "getPhoneNumber:fail",
  ]) {
    const f = fixture();
    await f.open();
    agree(f);
    await f.page.authorizeWechatPhone({ detail: { errMsg } });
    assert.deepEqual(f.calls, []);
    assert.equal(f.page.data.completed, false);
    assert.match(f.page.data.error, /重新点击微信一键登录/);
  }
});

test("withdrawing consent before the phone callback fails closed", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.calls, []);
});

test("capability failure fails closed for both phone methods", async () => {
  const f = fixture({ capabilitiesError: true });
  await f.open();
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  assert.equal(f.page.data.smsLoginEnabled, false);
  assert.equal(f.page.data.wechatPhoneLoginEnabled, false);
  assert.deepEqual(f.calls, []);
});

test("capabilities can be retried without collecting a phone or starting authentication", async () => {
  const options = { capabilitiesError: true };
  const f = fixture(options);
  await f.open();
  assert.equal(f.page.data.capabilitiesReady, true);
  assert.equal(f.page.data.wechatPhoneLoginEnabled, false);
  assert.equal(f.page.data.capabilitiesLoading, false);
  options.capabilitiesError = false;
  await f.page.loadLoginCapabilities();
  assert.equal(f.page.data.wechatPhoneLoginEnabled, true);
  assert.equal(f.page.data.smsLoginEnabled, true);
  assert.equal(f.page.data.error, "");
  assert.equal(f.page.data.accepted, false);
  assert.equal(f.capabilitiesCalls.length, 2);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.routes, []);
});

test("repeated capability retry requests share one in-flight request", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({ capabilitiesHandler: () => pending });
  const first = f.page.loadLoginCapabilities();
  const second = f.page.loadLoginCapabilities();
  const third = f.page.loadLoginCapabilities();
  assert.equal(f.capabilitiesCalls.length, 1);
  assert.equal(f.page.data.capabilitiesLoading, true);
  assert.equal(f.page.data.capabilitiesReady, false);
  resolve({ wechatPhoneLoginEnabled: true, smsLoginEnabled: false });
  await Promise.all([first, second, third]);
  assert.equal(f.page.data.capabilitiesLoading, false);
  assert.equal(f.page.data.wechatPhoneLoginEnabled, true);
  assert.equal(f.page.data.smsLoginEnabled, false);
});

test("capability retry is blocked during authentication or after destruction", async () => {
  const f = fixture();
  f.page.setData({ busy: true });
  await f.page.loadLoginCapabilities();
  assert.equal(f.capabilitiesCalls.length, 0);
  f.page.setData({ busy: false });
  f.page.onUnload();
  await f.page.loadLoginCapabilities();
  assert.equal(f.capabilitiesCalls.length, 0);
});

test("an obsolete capability response cannot overwrite a re-opened page's current result", async () => {
  let resolve;
  const old = new Promise((done) => {
    resolve = done;
  });
  let attempts = 0;
  const f = fixture({
    capabilitiesHandler: () => {
      attempts += 1;
      return attempts === 1
        ? old
        : { wechatPhoneLoginEnabled: true, smsLoginEnabled: false };
    },
  });
  const stale = f.page.loadLoginCapabilities();
  f.page.onUnload();
  await f.open();
  await f.page.loadLoginCapabilities();
  assert.equal(f.page.data.wechatPhoneLoginEnabled, true);
  resolve({ wechatPhoneLoginEnabled: false, smsLoginEnabled: true });
  await stale;
  assert.equal(f.page.data.wechatPhoneLoginEnabled, true);
  assert.equal(f.page.data.smsLoginEnabled, false);
  assert.equal(f.page.data.capabilitiesLoading, false);
});

test("SMS-unconfigured phone form opens with an honest hint but cannot send or login", async () => {
  const f = fixture({
    capabilities: { wechatPhoneLoginEnabled: true, smsLoginEnabled: false },
  });
  await f.open();
  agree(f);
  f.page.openSmsLogin();
  assert.equal(f.page.data.smsFormOpen, true);
  assert.match(f.page.data.smsUnavailableReason, /暂未开通/);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  await f.page.confirmSmsCode();
  assert.deepEqual(f.calls, []);
});

test("SMS login directly validates a phone challenge without any WeChat session", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  f.page.openSmsLogin();
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  assert.equal(f.stored(), undefined);
  assert.equal(f.page.data.smsChallengeId, "fixture-sms-challenge");
  f.page.updateSmsCode({ detail: { value: "123456" } });
  await f.page.confirmSmsCode();
  assert.deepEqual(f.calls, [
    { method: "sms-request", args: ["13800138000", true] },
    {
      method: "sms-confirm",
      args: ["13800138000", "123456", "fixture-sms-challenge", true],
    },
  ]);
  assert.deepEqual(f.routes, ["/pages/home/index"]);
  assert.equal(f.page.data.smsChallengeId, "");
  assert.equal(f.page.data.smsCode, "");
  assert.equal(f.timers.size, 0);
});

test("changing phone drops its code, challenge and resend countdown", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  f.page.updateSmsCode({ detail: { value: "123456" } });
  f.page.updatePhone({ detail: { value: "13900139000" } });
  assert.equal(f.page.data.smsChallengeId, "");
  assert.equal(f.page.data.smsCode, "");
  assert.equal(f.page.data.smsRequested, false);
  assert.equal(f.page.data.smsCountdown, 0);
  assert.equal(f.timers.size, 0);
  await f.page.confirmSmsCode();
  assert.equal(f.calls.length, 1);
  assert.match(f.page.data.error, /请先获取此手机号/);
});

test("busy native and SMS requests block double submit and phone edits", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({ loginPending: pending });
  await f.open();
  agree(f);
  const first = f.page.authorizeWechatPhone(phoneConsent);
  await f.page.authorizeWechatPhone(phoneConsent);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  f.page.toggleAccepted();
  assert.equal(f.page.data.phone, "");
  assert.equal(f.page.data.accepted, true);
  assert.equal(f.calls.length, 1);
  resolve();
  await first;
});

test("SMS resends wait for the server-provided cooldown and stop on unload", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  await f.page.requestSmsCode();
  assert.equal(f.calls.length, 1);
  assert.equal(f.page.data.smsCountdown, 60);
  f.tick();
  assert.equal(f.page.data.smsCountdown, 59);
  f.page.onUnload();
  assert.equal(f.timers.size, 0);
});

test("UNKNOWN SMS result does not invent delivery confirmation", async () => {
  const f = fixture({ smsStatus: "UNKNOWN" });
  await f.open();
  agree(f);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.requestSmsCode();
  assert.match(f.page.data.actionStatus, /状态待确认/);
  assert.doesNotMatch(f.page.data.actionStatus, /验证码已发送/);
});

test("invalid phone, missing challenge and short code cannot authenticate", async () => {
  const f = fixture();
  await f.open();
  agree(f);
  f.page.updatePhone({ detail: { value: "123" } });
  await f.page.requestSmsCode();
  assert.deepEqual(f.calls, []);
  f.page.updatePhone({ detail: { value: "13800138000" } });
  await f.page.confirmSmsCode();
  assert.deepEqual(f.calls, []);
  await f.page.requestSmsCode();
  f.page.updateSmsCode({ detail: { value: "1234" } });
  await f.page.confirmSmsCode();
  assert.equal(f.calls.length, 1);
  assert.match(f.page.data.error, /6 位验证码/);
});

test("authentication errors do not reveal staff roles, old identities or backend internals", async () => {
  const f = fixture({
    loginError: "用户 987 已绑定管理员手机号，SQL private table",
  });
  await f.open();
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.match(f.page.data.error, /暂未完成/);
  assert.doesNotMatch(f.page.data.error, /987|管理员|SQL|private/);
  assert.deepEqual(f.routes, []);
});

test("phone-unverified server responses cannot set completed or enter a business page", async () => {
  const f = fixture({ customerSession: session(false) });
  await f.open();
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.equal(f.page.data.completed, false);
  assert.deepEqual(f.routes, []);
  f.page.setData({ completed: true });
  f.page.enterHome();
  assert.deepEqual(f.routes, []);
});

test("a response after leaving the login page never navigates or publishes completion", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({ loginPending: pending });
  await f.open();
  agree(f);
  const first = f.page.authorizeWechatPhone(phoneConsent);
  f.page.onUnload();
  resolve();
  await first;
  assert.equal(f.page.data.completed, false);
  assert.deepEqual(f.routes, []);
});

test("staff and technician use their original WeChat subject in one click, never customer merge", async () => {
  for (const returnPath of [STAFF, TECHNICIAN]) {
    const f = fixture();
    await f.open(encodeURIComponent(returnPath));
    agree(f);
    await f.page.authorizeWechatPhone(phoneConsent);
    assert.deepEqual(f.calls, [
      { method: "wechat-identity" },
      { method: "subject-phone", args: ["fixture-native-phone-code"] },
    ]);
    assert.deepEqual(f.routes, [returnPath]);
    f.page.openSmsLogin();
    await f.page.requestSmsCode();
    assert.equal(f.page.data.smsFormOpen, false);
    assert.equal(f.calls.length, 2);
  }
});

test("staff's pending identity binds phone without switching to the customer phone account", async () => {
  const f = fixture({ stored: session(false) });
  await f.open(STAFF);
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.calls, [
    { method: "subject-phone", args: ["fixture-native-phone-code"] },
  ]);
  assert.deepEqual(f.routes, [STAFF]);
});

test("already verified legacy users keep their session and return safely without new registration", async () => {
  for (const returnPath of [undefined, STAFF, TECHNICIAN]) {
    const existing = session();
    const f = fixture({ stored: existing });
    await f.open(returnPath);
    assert.equal(f.stored(), existing);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.routes, [returnPath ?? "/pages/home/index"]);
  }
});

test("explicit forceChoice retains the dialog for existing WeChat and SMS customer sessions", async () => {
  for (const loginMethod of [undefined, "WECHAT", "PHONE_SMS"]) {
    const original = session(true, loginMethod);
    const f = fixture({ stored: original });
    await f.open(undefined, { forceChoice: "1" });
    assert.equal(f.page.data.completed, false);
    assert.equal(f.page.data.accepted, false);
    assert.deepEqual(f.routes, []);
    assert.deepEqual(f.calls, []);
    assert.equal(f.stored(), original);
    agree(f);
    await f.page.authorizeWechatPhone(phoneConsent);
    assert.deepEqual(f.calls, [
      { method: "atomic-wechat", args: ["fixture-native-phone-code", true] },
    ]);
    assert.deepEqual(f.routes, ["/pages/home/index"]);
  }
});

test("ordinary SMS session can still return to the customer homepage without another login", async () => {
  const original = session(true, "PHONE_SMS");
  const f = fixture({ stored: original });
  await f.open();
  assert.equal(f.page.data.completed, true);
  assert.equal(f.stored(), original);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.routes, ["/pages/home/index"]);
});

test("only exact forceChoice=1 affects automatic navigation and never bypasses authentication", async () => {
  for (const forceChoice of ["true", "yes", "2", "0"]) {
    const f = fixture({ stored: session(true, "WECHAT") });
    await f.open(undefined, { forceChoice });
    assert.equal(f.page.data.completed, true);
    assert.deepEqual(f.routes, ["/pages/home/index"]);
  }
  const anonymous = fixture();
  await anonymous.open(undefined, { forceChoice: "1" });
  anonymous.page.enterHome();
  anonymous.page.finish();
  assert.deepEqual(anonymous.routes, []);
});

test("SMS staff and technician returns stay in the dialog and require fresh WeChat identity", async () => {
  for (const returnPath of [STAFF, TECHNICIAN]) {
    const f = fixture({ stored: session(true, "PHONE_SMS") });
    await f.open(returnPath);
    assert.equal(f.page.data.completed, false);
    assert.deepEqual(f.routes, []);
    f.page.setData({ completed: true });
    f.page.enterHome();
    assert.deepEqual(f.routes, []);
    f.page.setData({ completed: false });
    agree(f);
    await f.page.authorizeWechatPhone(phoneConsent);
    assert.deepEqual(f.calls, [
      { method: "wechat-identity" },
      { method: "subject-phone", args: ["fixture-native-phone-code"] },
    ]);
    assert.deepEqual(f.routes, [returnPath]);
  }
});

test("even an unverified SMS-marked special session cannot bind its phone without fresh WeChat", async () => {
  const f = fixture({ stored: session(false, "PHONE_SMS") });
  await f.open(STAFF);
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.calls, [
    { method: "wechat-identity" },
    { method: "subject-phone", args: ["fixture-native-phone-code"] },
  ]);
  assert.deepEqual(f.routes, [STAFF]);
});

test("forceChoice allows fresh special login but cannot carry staff pairing/approval parameters", async () => {
  const f = fixture({
    stored: session(true, "WECHAT"),
    wechatSession: session(true, "WECHAT"),
  });
  await f.open(STAFF, {
    forceChoice: "1",
    pairCode: "untrusted",
    approved: "1",
  });
  assert.equal(f.page.data.completed, false);
  assert.deepEqual(f.routes, []);
  agree(f);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.calls, [{ method: "wechat-identity" }]);
  assert.deepEqual(f.routes, [STAFF]);
});

test("friend payer always reconfirms current WeChat identity without collecting a phone", async () => {
  const f = fixture({ stored: session() });
  await f.open(encodeURIComponent(FRIEND));
  assert.equal(f.page.data.completed, false);
  await f.page.authorizeWechat();
  assert.equal(f.calls.length, 0);
  agree(f);
  await f.page.authorizeWechat();
  assert.deepEqual(f.calls, [{ method: "wechat-identity" }]);
  assert.equal(f.stored().user.phoneVerified, false);
  assert.equal(f.page.data.completed, true);
  f.page.enterHome();
  assert.deepEqual(f.routes, [FRIEND]);
});

test("arbitrary return links cannot bypass phone verification or navigate outside the homepage", async () => {
  const f = fixture();
  await f.open(`https://evil.invalid${FRIEND}`);
  agree(f);
  assert.equal(f.page.data.friendPaymentReturn, false);
  await f.page.authorizeWechat();
  assert.deepEqual(f.calls, []);
  await f.page.authorizeWechatPhone(phoneConsent);
  assert.deepEqual(f.routes, ["/pages/home/index"]);
});

test("single green-white dialog stacks two actions and native phone consent only appears after consent", () => {
  const markup = source("pages/phone-verification/index.wxml");
  const style = source("pages/phone-verification/index.wxss");
  assert.match(markup, /class="login-dialog"/);
  assert.match(
    markup,
    /wx:elif="\{\{!accepted\}\}"[^>]*bindtap="handleWechatChoice"/,
  );
  assert.match(
    markup,
    /wx:else[^>]*open-type="getPhoneNumber"[^>]*bindgetphonenumber="authorizeWechatPhone"/,
  );
  assert.match(markup, /微信一键登录<\/button>[\s\S]*手机号码登录<\/button>/);
  assert.doesNotMatch(markup, /step-bar|第一步|第二步|微信授权已完成/);
  assert.match(markup, /smsCountdown > 0/);
  assert.match(markup, /\{\{smsUnavailableReason\}\}/);
  assert.match(
    markup,
    /bindtap="loadLoginCapabilities"[^>]*disabled="\{\{busy \|\| capabilitiesLoading\}\}"/,
  );
  assert.match(markup, /重新检测登录服务/);
  for (const name of ["《用户协议》", "《隐私政策》", "《上门服务公约》"])
    assert.ok(markup.includes(name));
  assert.match(style, /\.secondary-button\s*\{[\s\S]*margin-top: 20rpx/);
  assert.match(style, /#173c33/);
});

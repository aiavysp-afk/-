import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL(
    "../apps/miniapp/pages/technician-onboarding/index.js",
    import.meta.url,
  ),
  "utf8",
);
const session = (
  id = "owner",
  phoneVerified = true,
  loginMethod = "WECHAT",
) => ({
  accessToken: `token-${id}`,
  expiresAt: "2099-01-01T00:00:00Z",
  loginMethod,
  user: { id, phoneVerified, memberships: [] },
});
const state = (status = "DRAFT", canEnterWorkbench = false) => ({
  profile: { status },
  canEnterWorkbench,
  phoneVerified: true,
});
function fixture({
  initial,
  application = () => state(),
  enabled = true,
  login,
  request,
} = {}) {
  let page,
    currentSession = initial;
  const calls = [],
    routes = [],
    logins = [],
    phoneCodes = [];
  vm.runInNewContext(source, {
    exports: {},
    Error,
    Promise,
    Date,
    Object,
    Page(value) {
      page = {
        ...value,
        data: structuredClone(value.data),
        setData(patch) {
          Object.assign(this.data, patch);
        },
      };
    },
    getApp: () => ({ globalData: { apiBaseUrl: "https://fixture.test/v1" } }),
    require(name) {
      assert.equal(name, "../../utils/auth");
      return {
        getStoredSession: () => currentSession,
        clearStoredSession: () => {
          currentSession = undefined;
        },
        getCustomerLoginCapabilities: async () => ({
          wechatPhoneLoginEnabled: enabled,
          smsLoginEnabled: false,
        }),
        loginCustomerWithWechatPhone: async (code, accepted) => {
          logins.push(accepted);
          phoneCodes.push(code);
          currentSession = await (login?.(code, accepted) ??
            Promise.resolve(session("native")));
          return currentSession;
        },
      };
    },
    wx: {
      showShareMenu() {},
      redirectTo: ({ url }) => routes.push(url),
      navigateTo: ({ url }) => routes.push(url),
      request(input) {
        calls.push(input);
        if (request) return request(input);
        Promise.resolve(application(input.method)).then((data) =>
          input.success({ statusCode: 200, data: { data } }),
        );
      },
    },
  });
  return {
    page,
    calls,
    routes,
    logins,
    phoneCodes,
    getSession: () => currentSession,
    setSession: (value) => {
      currentSession = value;
    },
  };
}
const authorization = { detail: { code: "native-user-authorized-phone-code" } };

test("scanning entry without a verified WeChat session stays at the dedicated login without creating an application", async () => {
  for (const initial of [
    undefined,
    session("sms", true, "PHONE_SMS"),
    session("unverified", false),
  ]) {
    const f = fixture({ initial });
    await f.page.onShow();
    assert.equal(f.page.data.authenticated, false);
    assert.equal(f.page.data.capabilitiesReady, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.routes.length, 0);
    assert.equal(f.logins.length, 0);
  }
});

test("one explicit consent and WeChat authorization creates the owner draft then opens its form", async () => {
  const f = fixture({
    application: (method) =>
      method === "POST"
        ? state()
        : { profile: null, canEnterWorkbench: false, phoneVerified: true },
  });
  await f.page.onShow();
  await f.page.authorizeWechat(authorization);
  assert.equal(f.logins.length, 0);
  assert.equal(f.calls.length, 0);
  f.page.toggleAccepted();
  await f.page.authorizeWechat(authorization);
  assert.equal(f.logins.length, 1);
  assert.deepEqual(f.phoneCodes, ["native-user-authorized-phone-code"]);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["GET", "POST"],
  );
  assert.equal(f.calls[0].data, undefined);
  assert.equal(f.calls[0].header["content-type"], "text/plain");
  assert.equal(f.calls[1].header.Authorization, "Bearer token-native");
  assert.deepEqual(Object.keys(f.calls[1].data), []);
  assert.deepEqual(f.routes, ["/pages/technician-application/index"]);
  assert.equal(f.page.data.busy, false);
});

test("cancelled authorization and a disabled provider never create profiles or send SMS", async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.toggleAccepted();
  await f.page.authorizeWechat({
    detail: { errMsg: "getPhoneNumber:fail user deny" },
  });
  assert.match(f.page.data.error, /取消/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logins.length, 0);
  const disabled = fixture({ enabled: false });
  await disabled.page.onShow();
  disabled.page.toggleAccepted();
  await disabled.page.authorizeWechat(authorization);
  assert.equal(disabled.logins.length, 0);
  assert.equal(disabled.calls.length, 0);
  assert.match(disabled.page.data.error, /未就绪/);
});

test("repeated authorization taps create one login and one registration request", async () => {
  let finishLogin;
  const f = fixture({
    login: () =>
      new Promise((resolve) => {
        finishLogin = resolve;
      }),
    application: (method) =>
      method === "POST"
        ? state()
        : { profile: null, canEnterWorkbench: false, phoneVerified: true },
  });
  await f.page.onShow();
  f.page.toggleAccepted();
  const first = f.page.authorizeWechat(authorization);
  const repeated = f.page.authorizeWechat(authorization);
  finishLogin(session("native"));
  await Promise.all([first, repeated]);
  assert.equal(f.logins.length, 1);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  assert.deepEqual(f.routes, ["/pages/technician-application/index"]);
});

test("existing draft and rejected applications resume; pending stays and approved is server gated", async () => {
  for (const [status, allowed, path] of [
    ["DRAFT", false, "/pages/technician-application/index"],
    ["REJECTED", false, "/pages/technician-application/index"],
    ["PENDING_REVIEW", false, undefined],
    ["APPROVED", false, undefined],
    ["APPROVED", true, "/pages/technician-workbench/index"],
    ["PUBLISHED", true, "/pages/technician-workbench/index"],
  ]) {
    const f = fixture({
      initial: session(),
      application: () => state(status, allowed),
    });
    await Promise.all([f.page.onShow(), f.page.onShow()]);
    assert.equal(f.calls.length, 1, status);
    assert.deepEqual(f.routes, path ? [path] : [], status);
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0, status);
  }
});

test("expired entry session remains at technician login; obsolete 401 does not erase a replacement session", async () => {
  const expired = fixture({
    initial: session(),
    request: (input) =>
      input.success({ statusCode: 401, data: { message: "请重新授权" } }),
  });
  await expired.page.onShow();
  assert.equal(expired.getSession(), undefined);
  assert.equal(expired.page.data.authenticated, false);
  assert.deepEqual(expired.routes, []);
  let oldRequest;
  const replacement = fixture({
    initial: session("old"),
    request: (input) => {
      oldRequest = input;
    },
  });
  const loading = replacement.page.onShow();
  replacement.setSession(session("new"));
  oldRequest.success({ statusCode: 401, data: { message: "旧会话失效" } });
  await loading;
  assert.equal(replacement.getSession().user.id, "new");
  assert.deepEqual(replacement.routes, []);
});

test("atomic WeChat login resumes the existing phone applicant account without a second registration", async () => {
  const existingPhoneSession = session(
    "existing-phone-owner",
    true,
    "PHONE_SMS",
  );
  const f = fixture({
    initial: existingPhoneSession,
    login: async (_code, accepted) => {
      assert.equal(accepted, true);
      return { ...existingPhoneSession, loginMethod: "WECHAT" };
    },
    application: () => ({
      profile: { status: "DRAFT", technicianId: "existing-phone-owner" },
      phoneVerified: true,
      canEnterWorkbench: false,
    }),
  });
  await f.page.onShow();
  assert.equal(f.calls.length, 0);
  f.page.toggleAccepted();
  await f.page.authorizeWechat(authorization);
  assert.equal(f.getSession().user.id, "existing-phone-owner");
  assert.equal(
    f.calls[0].header.Authorization,
    "Bearer token-existing-phone-owner",
  );
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  assert.deepEqual(f.routes, ["/pages/technician-application/index"]);
});

test("a server-side phone verification invalidation reopens the dedicated authorization page", async () => {
  const f = fixture({
    initial: session(),
    application: () => ({
      profile: { status: "DRAFT" },
      phoneVerified: false,
      canEnterWorkbench: false,
    }),
  });
  await f.page.onShow();
  assert.equal(f.page.data.authenticated, false);
  assert.equal(f.getSession(), undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.routes, []);
  assert.match(f.page.data.error, /重新点击微信授权/);
});

test("responses after leaving the entry cannot redirect or register an applicant", async () => {
  let pending;
  const f = fixture({
    initial: session(),
    request: (input) => {
      pending = input;
    },
  });
  const loading = f.page.onShow();
  f.page.onUnload();
  pending.success({
    statusCode: 200,
    data: {
      data: { profile: null, phoneVerified: true, canEnterWorkbench: false },
    },
  });
  await loading;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.routes, []);
});

test("entry uses the native authorization button and exact local agreement destinations", async () => {
  const wxml = readFileSync(
    new URL(
      "../apps/miniapp/pages/technician-onboarding/index.wxml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(wxml, /bindgetphonenumber="authorizeWechat"/);
  assert.doesNotMatch(wxml, /<input|短信验证码|配对码/);
  const f = fixture();
  for (const type of ["user", "privacy", "service", "https://evil.invalid"])
    f.page.openAgreement({ currentTarget: { dataset: { type } } });
  assert.deepEqual(f.routes, [
    "/pages/agreement/index?type=user",
    "/pages/agreement/index?type=privacy",
    "/pages/agreement/index?type=service",
  ]);
  assert.equal(
    f.page.onShareAppMessage().path,
    "/pages/technician-onboarding/index",
  );
});

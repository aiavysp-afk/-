import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pagePath = "../apps/miniapp/pages/phone-verification/index.js";
const storageKey = "zydj.auth.session";

function createPage() {
  let definition;
  const previousPage = globalThis.Page;
  globalThis.Page = (options) => {
    definition = options;
  };
  try {
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
  } finally {
    globalThis.Page = previousPage;
  }
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
}

function installWx({ requests = [], smsRequestFailure, storedSession } = {}) {
  const previousWx = globalThis.wx;
  const previousGetApp = globalThis.getApp;
  let session = storedSession;
  const navigations = [];
  const modals = [];
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "https://api.fixture.test/v1" },
  });
  globalThis.wx = {
    getStorageSync: (key) => (key === storageKey ? session : undefined),
    setStorageSync: (key, value) => {
      if (key === storageKey) session = value;
    },
    removeStorageSync: () => {
      session = undefined;
    },
    login: ({ success }) => success({ code: "wechat-login-code" }),
    request: (options) => {
      requests.push(options);
      if (options.url.endsWith("/auth/wechat-miniapp")) {
        options.success({
          statusCode: 200,
          data: {
            data: {
              accessToken: "x".repeat(40),
              expiresAt: "2099-01-01T00:00:00.000Z",
              user: {
                id: "fixture-user",
                displayName: "微信用户",
                phoneVerified: false,
                memberships: [],
              },
            },
          },
        });
        return;
      }
      if (options.url.endsWith("/auth/sms-phone/request")) {
        if (smsRequestFailure) {
          options.fail({ errMsg: smsRequestFailure });
          return;
        }
        options.success({
          statusCode: 200,
          data: {
            data: {
              status: "ACCEPTED",
              expiresAt: "2099-01-01T00:05:00.000Z",
              retryAfterSeconds: 60,
            },
          },
        });
        return;
      }
      if (options.url.endsWith("/auth/sms-phone/confirm")) {
        options.success({
          statusCode: 200,
          data: {
            data: { phoneVerified: true, maskedPhone: "138****8000" },
          },
        });
        return;
      }
      options.fail({ errMsg: "unexpected request" });
    },
    showToast() {},
    showModal: (options) => modals.push(options),
    navigateTo: ({ url }) => navigations.push(url),
    navigateBack() {},
    switchTab: ({ url }) => navigations.push(url),
  };
  return {
    modals,
    navigations,
    requests,
    restore() {
      globalThis.wx = previousWx;
      globalThis.getApp = previousGetApp;
    },
  };
}

test("login page defaults to all three agreements accepted and opens each document", () => {
  const host = installWx();
  try {
    const page = createPage();
    assert.equal(page.data.accepted, true);
    for (const type of ["user", "privacy", "service"]) {
      page.openAgreement({ currentTarget: { dataset: { type } } });
    }
    assert.deepEqual(host.navigations, [
      "/pages/agreement/index?type=user",
      "/pages/agreement/index?type=privacy",
      "/pages/agreement/index?type=service",
    ]);
  } finally {
    host.restore();
  }
});

test("unchecked agreements stop WeChat authorization before any account request", async () => {
  const host = installWx();
  try {
    const page = createPage();
    page.data.accepted = false;
    await page.authorizeWechat();
    assert.equal(host.requests.length, 0);
    assert.match(page.data.error, /请先阅读并同意/);
  } finally {
    host.restore();
  }
});

test("WeChat authorization completes step one without silently requesting a phone", async () => {
  const host = installWx();
  try {
    const page = createPage();
    await page.authorizeWechat();
    assert.deepEqual(
      host.requests.map((request) => request.url),
      ["https://api.fixture.test/v1/auth/wechat-miniapp"],
    );
    assert.equal(page.data.wechatReady, true);
    assert.equal(page.data.completed, false);
  } finally {
    host.restore();
  }
});

test("SMS verification runs only after WeChat authorization and completes login", async () => {
  const host = installWx();
  try {
    const page = createPage();
    await page.authorizeWechat();
    page.data.phone = "13800138000";
    await page.requestSmsCode();
    page.data.smsCode = "123456";
    await page.confirmSmsCode();
    assert.deepEqual(
      host.requests.map((request) => request.url),
      [
        "https://api.fixture.test/v1/auth/wechat-miniapp",
        "https://api.fixture.test/v1/auth/sms-phone/request",
        "https://api.fixture.test/v1/auth/sms-phone/confirm",
      ],
    );
    assert.match(host.requests[1].header.Authorization, /^Bearer /);
    assert.match(host.requests[2].header.Authorization, /^Bearer /);
    assert.equal(host.requests[0].timeout, 12_000);
    assert.equal(host.requests[1].timeout, 12_000);
    assert.equal(host.requests[2].timeout, 12_000);
    assert.equal(page.data.completed, true);
    assert.equal(page.data.maskedPhone, "138****8000");
    page.onUnload();
  } finally {
    host.restore();
  }
});

test("SMS network failures remain visible instead of leaving an unresponsive button", async () => {
  const host = installWx({
    smsRequestFailure: "request:fail timeout",
    storedSession: {
      accessToken: "x".repeat(40),
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        id: "fixture-user",
        displayName: "微信用户",
        phoneVerified: false,
        memberships: [],
      },
    },
  });
  try {
    const page = createPage();
    page.data.phone = "13800138000";
    await page.requestSmsCode();
    assert.equal(page.data.busy, false);
    assert.equal(page.data.actionStatus, "验证码未发送");
    assert.match(page.data.error, /请求超时/);
    assert.equal(host.modals.at(-1)?.title, "验证码发送失败");
  } finally {
    host.restore();
  }
});

test("SMS step cannot silently recreate an expired WeChat session", async () => {
  const host = installWx();
  try {
    const page = createPage();
    page.data.wechatReady = true;
    page.data.phone = "13800138000";
    await page.requestSmsCode();
    assert.equal(host.requests.length, 0);
    assert.equal(page.data.wechatReady, false);
    assert.match(page.data.error, /先重新完成微信授权/);
  } finally {
    host.restore();
  }
});

test("invalid SMS phone is rejected locally without starting authorization", async () => {
  const host = installWx({
    storedSession: {
      accessToken: "x".repeat(40),
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        id: "fixture-user",
        displayName: "微信用户",
        phoneVerified: false,
        memberships: [],
      },
    },
  });
  try {
    const page = createPage();
    page.data.phone = "123";
    await page.requestSmsCode();
    assert.equal(host.requests.length, 0);
    assert.equal(page.data.error, "请输入正确的 11 位手机号");
  } finally {
    host.restore();
  }
});

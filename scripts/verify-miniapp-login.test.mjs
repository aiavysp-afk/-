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

function installWx({ requests = [], storedSession } = {}) {
  const previousWx = globalThis.wx;
  const previousGetApp = globalThis.getApp;
  let session = storedSession;
  const navigations = [];
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
      if (options.url.endsWith("/auth/wechat-phone")) {
        options.success({
          statusCode: 200,
          data: { data: { phoneVerified: true, maskedPhone: "138****8000" } },
        });
        return;
      }
      options.fail({ errMsg: "unexpected request" });
    },
    showToast() {},
    navigateTo: ({ url }) => navigations.push(url),
    navigateBack() {},
    switchTab: ({ url }) => navigations.push(url),
  };
  return {
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

test("unchecked agreements stop login before any account or phone request", async () => {
  const host = installWx();
  try {
    const page = createPage();
    page.data.accepted = false;
    await page.quickLogin({ detail: { code: "phone-code" } });
    assert.equal(host.requests.length, 0);
    assert.match(page.data.error, /请先阅读并同意/);
  } finally {
    host.restore();
  }
});

test("one-tap phone login reuses WeChat auto-registration then verifies the phone", async () => {
  const host = installWx();
  try {
    const page = createPage();
    await page.quickLogin({ detail: { code: "phone-code" } });
    assert.deepEqual(
      host.requests.map((request) => request.url),
      [
        "https://api.fixture.test/v1/auth/wechat-miniapp",
        "https://api.fixture.test/v1/auth/wechat-phone",
      ],
    );
    assert.equal(host.requests[1].data.code, "phone-code");
    assert.match(host.requests[1].header.Authorization, /^Bearer /);
    assert.equal(page.data.completed, true);
    assert.equal(page.data.maskedPhone, "138****8000");
  } finally {
    host.restore();
  }
});

test("invalid SMS phone is rejected locally without starting WeChat login", async () => {
  const host = installWx();
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

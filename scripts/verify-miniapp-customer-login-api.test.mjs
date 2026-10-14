import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const old = {
  accessToken: "old".repeat(16),
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: {
    id: "old-user",
    displayName: "旧用户",
    phoneVerified: true,
    memberships: [],
  },
};
const next = {
  ...old,
  accessToken: "new".repeat(16),
  user: { ...old.user, id: "canonical-old-id" },
};
function host(response = next, initial = old, statusCode = 200) {
  let storage = arguments.length > 1 ? arguments[1] : initial;
  const calls = [];
  let wxLogins = 0;
  const wx = {
    getStorageSync: () => storage,
    setStorageSync: (_key, value) => {
      storage = value;
    },
    removeStorageSync: () => {
      storage = undefined;
    },
    login: (options) => {
      wxLogins++;
      options.success({ code: "fresh-wechat-code" });
    },
    request: (options) => {
      calls.push(options);
      options.success({
        statusCode,
        data: {
          data: statusCode === 200 ? response : undefined,
          message: statusCode === 200 ? undefined : "暂未开通",
        },
      });
    },
  };
  const filename = new URL("../apps/miniapp/utils/auth.ts", import.meta.url);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    wx,
    getApp: () => ({
      globalData: { apiBaseUrl: "https://api.example.test/v1" },
    }),
    require: (name) =>
      name === "./login-return"
        ? { safeLoginReturnPath: () => "" }
        : require(name),
    Date,
    Promise,
    Error,
  });
  return {
    auth: exports,
    calls,
    storage: () => storage,
    wxLogins: () => wxLogins,
  };
}
test("new login helpers refuse implicit consent before requesting anything", async () => {
  const h = host();
  await assert.rejects(
    h.auth.loginCustomerWithWechatPhone("phone-code"),
    /协议/,
  );
  await assert.rejects(h.auth.requestCustomerSmsLogin("13800138000"), /协议/);
  await assert.rejects(
    h.auth.confirmCustomerSmsLogin(
      "13800138000",
      "123456",
      "challenge-123456789",
    ),
    /协议/,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.wxLogins(), 0);
  assert.equal(h.storage(), old);
});
test("one authorized click supplies two distinct codes to one atomic endpoint", async () => {
  const h = host();
  assert.equal(
    (await h.auth.loginCustomerWithWechatPhone("authorized-phone-code", true))
      .user.id,
    next.user.id,
  );
  assert.equal(h.storage().loginMethod, "WECHAT");
  assert.equal(h.wxLogins(), 1);
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0].url,
    "https://api.example.test/v1/auth/customer-login/wechat-phone",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].data)), {
    code: "fresh-wechat-code",
    phoneCode: "authorized-phone-code",
    agreementsAccepted: true,
  });
  assert.equal(h.calls[0].header.Authorization, undefined);
  assert.equal(h.storage().user.id, "canonical-old-id");
});
test("SMS sends work with no old WeChat login, no bearer and no temporary account", async () => {
  const result = {
    challengeId: "customer-challenge-123456",
    status: "UNKNOWN",
    expiresAt: "2099-01-01T00:00:00.000Z",
    retryAfterSeconds: 60,
  };
  const h = host(result, undefined);
  assert.equal(
    await h.auth.requestCustomerSmsLogin("13800138000", true),
    result,
  );
  assert.equal(h.wxLogins(), 0);
  assert.equal(h.calls[0].header.Authorization, undefined);
  assert.equal(h.calls[0].url.endsWith("/sms/request"), true);
  assert.equal(h.storage(), undefined);
});
test("SMS confirmation stores the original canonical owner only after verified success", async () => {
  const h = host();
  await h.auth.confirmCustomerSmsLogin(
    "13800138000",
    "012345",
    "customer-challenge-123456",
    true,
  );
  assert.equal(h.wxLogins(), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].header.Authorization, undefined);
  assert.equal(h.storage().user.id, "canonical-old-id");
  assert.equal(h.storage().loginMethod, "PHONE_SMS");
});
test("bad authorization, failed server responses and unverified sessions preserve old data", async () => {
  const empty = host();
  await assert.rejects(empty.auth.loginCustomerWithWechatPhone("", true));
  assert.equal(empty.wxLogins(), 0);
  const refused = host(undefined, old, 503);
  await assert.rejects(
    refused.auth.loginCustomerWithWechatPhone("phone-code", true),
    /暂未开通/,
  );
  assert.equal(refused.storage(), old);
  const unverified = host({
    ...next,
    user: { ...next.user, phoneVerified: false },
  });
  await assert.rejects(
    unverified.auth.loginCustomerWithWechatPhone("phone-code", true),
    /未完成/,
  );
  assert.equal(unverified.storage(), old);
});
test("capability checks use an anonymous bodyless GET safe for Fastify", async () => {
  const capabilities = {
    wechatPhoneLoginEnabled: true,
    smsLoginEnabled: false,
  };
  const h = host(capabilities);
  assert.equal(await h.auth.getCustomerLoginCapabilities(), capabilities);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].data, undefined);
  assert.equal(h.calls[0].header["content-type"], "text/plain");
  assert.equal(h.calls[0].header.Authorization, undefined);
  assert.equal(h.storage(), old);
});

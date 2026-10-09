import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const requireApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const fastify = requireApi("fastify");

const source = await readFile(
  new URL("../apps/miniapp/utils/api.js", import.meta.url),
  "utf8",
);

function fixture({
  session,
  response = { statusCode: 200, data: { data: { hidden: true } } },
  networkFailure = false,
} = {}) {
  const calls = [];
  let clears = 0;
  let redirects = 0;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    getApp: () => ({
      globalData: { apiBaseUrl: "https://fixture.invalid/v1" },
    }),
    require(name) {
      assert.equal(name, "./auth");
      return {
        getStoredSession: () => session,
        clearStoredSession: () => clears++,
        redirectToCustomerLogin: () => redirects++,
      };
    },
    wx: {
      request(options) {
        calls.push(options);
        if (networkFailure) options.fail();
        else options.success(response);
      },
    },
  });
  return {
    api: exports.api,
    calls,
    get clears() {
      return clears;
    },
    get redirects() {
      return redirects;
    },
  };
}

for (const method of ["GET", "DELETE", "POST", "PATCH"]) {
  test(`bodyless ${method} opts out of wx.request default JSON and omits data`, async () => {
    const f = fixture({ session: { accessToken: "fixture-customer-token" } });
    const result = await f.api(
      "/orders/fixture-order",
      method,
      undefined,
      "fixture-idempotency-key",
    );
    assert.equal(result.hidden, true);
    assert.equal(f.calls.length, 1);
    const request = f.calls[0];
    assert.equal(request.method, method);
    assert.equal(
      request.url,
      "https://fixture.invalid/v1/orders/fixture-order",
    );
    assert.equal(Object.hasOwn(request, "data"), false);
    assert.equal(request.header["content-type"], "text/plain");
    assert.equal(request.header.Authorization, "Bearer fixture-customer-token");
    assert.equal(request.header["Idempotency-Key"], "fixture-idempotency-key");
  });
}

test("requests with data preserve JSON encoding, including an empty object", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    for (const data of [null, {}, { acknowledgedRisk: true, quantity: 2 }]) {
      const f = fixture();
      await f.api("/fixture", method, data);
      assert.equal(f.calls[0].data, data);
      assert.equal(f.calls[0].header["content-type"], "application/json");
      assert.equal(Object.hasOwn(f.calls[0].header, "Authorization"), false);
      assert.equal(Object.hasOwn(f.calls[0].header, "Idempotency-Key"), false);
    }
  }
});

test("real Fastify accepts bodyless removal headers while the previous empty JSON request fails before the handler", async () => {
  const server = fastify();
  let removals = 0;
  server.delete("/orders/fixture", async () => {
    removals++;
    return { data: { hidden: true } };
  });
  try {
    const previous = await server.inject({
      method: "DELETE",
      url: "/orders/fixture",
      headers: { "content-type": "application/json", "content-length": "0" },
    });
    assert.equal(previous.statusCode, 400);
    assert.match(previous.json().message, /Body cannot be empty/);
    assert.equal(removals, 0);

    const f = fixture({ session: { accessToken: "fixture-customer-token" } });
    await f.api("/orders/fixture", "DELETE");
    const request = f.calls[0];
    const fixed = await server.inject({
      method: request.method,
      url: "/orders/fixture",
      headers: { ...request.header, "content-length": "0" },
    });
    assert.equal(fixed.statusCode, 200);
    assert.equal(fixed.json().data.hidden, true);
    assert.equal(removals, 1);
  } finally {
    await server.close();
  }
});

test("bodyless authorization errors still clear the session and redirect exactly once", async () => {
  const f = fixture({
    session: { accessToken: "expired-fixture-token" },
    response: { statusCode: 401, data: { message: "请重新登录" } },
  });
  await assert.rejects(f.api("/orders/fixture", "DELETE"), {
    message: "请重新登录",
  });
  assert.equal(f.clears, 1);
  assert.equal(f.redirects, 1);
  assert.equal(f.calls.length, 1);
});

test("non-success responses and missing response data cannot be reported as successful removal", async () => {
  for (const response of [
    { statusCode: 403, data: { message: "订单不属于当前客户" } },
    { statusCode: 200, data: {} },
  ]) {
    const f = fixture({ response });
    await assert.rejects(f.api("/orders/fixture", "DELETE"));
    assert.equal(f.clears, 0);
    assert.equal(f.redirects, 0);
  }
});

test("network failure keeps the existing retry guidance without retrying a mutation", async () => {
  const f = fixture({ networkFailure: true });
  await assert.rejects(f.api("/orders/fixture", "DELETE"), {
    message: "网络连接失败，请保留当前页面后重试",
  });
  assert.equal(f.calls.length, 1);
});

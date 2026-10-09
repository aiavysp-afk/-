import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function fixture(respond) {
  const exports = {}, cleared = [], redirects = [], requests = [];
  vm.runInNewContext(readFileSync(new URL("../apps/miniapp/utils/api.js", import.meta.url), "utf8"), {
    exports, Error,
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.example.com/v1" } }),
    require: () => ({
      getStoredSession: () => ({ accessToken: "fixture-token" }),
      clearStoredSession: () => cleared.push(true),
      redirectToCustomerLogin: () => redirects.push(true),
    }),
    wx: { request(options) { requests.push(options); respond(options); } },
  });
  return { ...exports, cleared, redirects, requests };
}

test("HTTP business rejections retain status and endpoint without leaking request credentials or body", async () => {
  const f = fixture((options) => options.success({ statusCode: 409, data: { message: "优惠券状态已变化，请重新获取报价" } }));
  await assert.rejects(f.api("/orders", "POST", { privateAddress: "private fixture" }, "fixture-key"), (error) => {
    assert.equal(error instanceof f.ApiError, true);
    assert.equal(error.statusCode, 409); assert.equal(error.path, "/orders"); assert.equal(error.method, "POST");
    assert.equal(error.message, "优惠券状态已变化，请重新获取报价");
    assert.doesNotMatch(JSON.stringify(error), /fixture-token|fixture-key|private fixture/);
    return true;
  });
});

test("network failures stay untyped and therefore cannot be mistaken for definite HTTP rejection", async () => {
  const f = fixture((options) => options.fail({ errMsg: "request:fail timeout" }));
  await assert.rejects(f.api("/orders", "POST", {}), (error) => {
    assert.equal(error instanceof f.ApiError, false); assert.match(error.message, /网络连接失败/); return true;
  });
});

test("server failures retain their 5xx status and authentication redirects remain unchanged", async () => {
  for (const statusCode of [401, 500, 503]) {
    const f = fixture((options) => options.success({ statusCode, data: {} }));
    await assert.rejects(f.api("/orders", "POST", {}), (error) => error instanceof f.ApiError && error.statusCode === statusCode);
    assert.equal(f.cleared.length, statusCode === 401 ? 1 : 0);
    assert.equal(f.redirects.length, statusCode === 401 ? 1 : 0);
  }
});

test("successful API responses and empty-body headers retain their existing behavior", async () => {
  const f = fixture((options) => options.success({ statusCode: 200, data: { data: { ok: true } } }));
  assert.deepEqual(await f.api("/catalog/services"), { ok: true });
  assert.equal(f.requests[0].header["content-type"], "text/plain");
  assert.equal(Object.hasOwn(f.requests[0], "data"), false);
});

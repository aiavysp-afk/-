import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  openWecomCustomerService,
  callEmergencyDuty,
} = require("../apps/miniapp/utils/customer-service.js");
const contact = {
  provider: "wecom",
  available: true,
  corpId: "ww1234567890abcdef",
  url: "https://work.weixin.qq.com/kfid/kfc_test_12345",
};
function fixture(sdk = true) {
  const calls = [],
    toasts = [];
  const host = {
    showToast: (input) => toasts.push(input),
    ...(sdk ? { openCustomerServiceChat: (input) => calls.push(input) } : {}),
  };
  return { host, calls, toasts };
}
test("compiled miniapp invokes the native API synchronously with official public identifiers", () => {
  const f = fixture();
  openWecomCustomerService(contact, f.host);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].extInfo, { url: contact.url });
  assert.equal(f.calls[0].corpId, contact.corpId);
  assert.equal(f.toasts.length, 0);
});
test("unconfigured contacts and malicious URLs never invoke the native API", () => {
  for (const value of [
    undefined,
    { ...contact, available: false },
    { ...contact, url: "https://evil.test" },
    { ...contact, corpId: "invalid" },
  ]) {
    const f = fixture();
    openWecomCustomerService(value, f.host);
    assert.equal(f.calls.length, 0);
    assert.equal(f.toasts.length, 1);
  }
});
test("old clients and native invocation failure show an honest fallback, never acknowledgement", () => {
  const old = fixture(false);
  openWecomCustomerService(contact, old.host);
  assert.match(old.toasts[0].title, /升级/);
  const f = fixture();
  openWecomCustomerService(contact, f.host);
  f.calls[0].fail({ errMsg: "private-provider-error" });
  assert.match(f.toasts[0].title, /未打开/);
  assert.doesNotMatch(f.toasts[0].title, /private-provider-error/);
});
test("emergency calls use the configured number without claiming connection", () => {
  const f = fixture();
  const calls = [];
  f.host.makePhoneCall = (input) => calls.push(input);
  callEmergencyDuty({ configured: true, phone: "13800138000" }, f.host);
  assert.equal(calls[0].phoneNumber, "13800138000");
  assert.equal(f.toasts.length, 0);
  calls[0].fail({ errMsg: "private-error" });
  assert.match(f.toasts[0].title, /未完成/);
});
test("missing/unsafe emergency numbers cannot invoke the dialer", () => {
  for (const contact of [
    undefined,
    { configured: false, phone: "13800138000" },
    { configured: true, phone: "13800138000&url=evil" },
  ]) {
    const f = fixture();
    f.host.makePhoneCall = () => assert.fail("unexpected dialer call");
    callEmergencyDuty(contact, f.host);
    assert.equal(f.toasts.length, 1);
  }
});

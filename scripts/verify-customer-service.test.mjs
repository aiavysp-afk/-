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
    assert.match(f.toasts[0].title, /未就绪/);
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

test("native method keeps its wx receiver and runs inside the original synchronous tap", () => {
  const f = fixture();
  let returned = false;
  f.host.openCustomerServiceChat = function (input) {
    assert.equal(this, f.host);
    assert.equal(returned, false);
    f.calls.push(input);
  };
  openWecomCustomerService(contact, f.host);
  returned = true;
  assert.equal(f.calls.length, 1);
});

test("local diagnostics distinguish config, client, callback and synchronous throw", () => {
  const diagnostics = [];
  const receive = (value) => diagnostics.push(value);
  const invalid = fixture();
  openWecomCustomerService(undefined, invalid.host, receive);
  const old = fixture(false);
  openWecomCustomerService(contact, old.host, receive);
  const failed = fixture();
  openWecomCustomerService(contact, failed.host, receive);
  failed.calls[0].fail({
    errCode: -4,
    errMsg: "openCustomerServiceChat:fail permission denied",
  });
  const thrown = fixture();
  thrown.host.openCustomerServiceChat = function () {
    assert.equal(this, thrown.host);
    throw {
      errCode: "12",
      errMsg: "openCustomerServiceChat:fail not supported",
    };
  };
  assert.doesNotThrow(() =>
    openWecomCustomerService(contact, thrown.host, receive),
  );
  assert.deepEqual(diagnostics, [
    { stage: "CONFIG", code: "NOT_PROVIDED", signal: "CONTACT_UNAVAILABLE" },
    { stage: "CLIENT", code: "NOT_PROVIDED", signal: "API_UNAVAILABLE" },
    { stage: "SDK_CALLBACK", code: "-4", signal: "PERMISSION_WORDING" },
    { stage: "SDK_THROW", code: "12", signal: "UNSUPPORTED_WORDING" },
  ]);
  assert.equal(invalid.calls.length, 0);
  assert.equal(old.calls.length, 0);
  assert.equal(failed.calls.length, 1);
  assert.equal(thrown.toasts.length, 1);
});

test("diagnostic code accepts only bounded decimal integers, not arbitrary provider fields", () => {
  for (const [value, expected] of [
    [0, "0"],
    [999999999, "999999999"],
    [-999999999, "-999999999"],
    ["0012", "12"],
    [Infinity, "NOT_PROVIDED"],
    [NaN, "NOT_PROVIDED"],
    [1.25, "NOT_PROVIDED"],
    [1000000000, "NOT_PROVIDED"],
    ["18018180000", "NOT_PROVIDED"],
    ["fixture-secret", "NOT_PROVIDED"],
    [{ toString: () => "fixture-secret" }, "NOT_PROVIDED"],
  ]) {
    const f = fixture(),
      diagnostics = [];
    openWecomCustomerService(contact, f.host, (value) =>
      diagnostics.push(value),
    );
    f.calls[0].fail({
      errCode: value,
      errMsg: "fixture-private-error",
      privateSecret: "fixture-secret",
    });
    assert.equal(diagnostics[0].code, expected);
    assert.equal(diagnostics[0].signal, "UNKNOWN");
    assert.doesNotMatch(
      JSON.stringify([diagnostics, f.toasts]),
      /fixture-secret|private-error|18018180000/,
    );
  }
});

test("wording clues are fixed enums, not official error mappings or raw-text diagnostics", () => {
  for (const [message, signal, code] of [
    [
      "openCustomerServiceChat:fail unsupported",
      "UNSUPPORTED_WORDING",
      "NOT_PROVIDED",
    ],
    [
      "openCustomerServiceChat:fail user tap required",
      "GESTURE_WORDING",
      "NOT_PROVIDED",
    ],
    [
      "openCustomerServiceChat:fail invalid corpId",
      "ARGUMENT_WORDING",
      "NOT_PROVIDED",
    ],
    ["openCustomerServiceChat:fail cancel", "CANCEL_WORDING", "NOT_PROVIDED"],
    [
      "openCustomerServiceChat:fail network timeout",
      "NETWORK_WORDING",
      "NOT_PROVIDED",
    ],
    [
      "openCustomerServiceChat:fail errCode=12345 fixture-private-detail",
      "UNKNOWN",
      "NOT_PROVIDED",
    ],
    [
      "openCustomerServiceChat:fail error code: 1234567890",
      "UNKNOWN",
      "NOT_PROVIDED",
    ],
  ]) {
    const f = fixture(),
      diagnostics = [];
    openWecomCustomerService(contact, f.host, (value) =>
      diagnostics.push(value),
    );
    f.calls[0].fail({ errMsg: message });
    assert.deepEqual(diagnostics[0], { stage: "SDK_CALLBACK", code, signal });
    assert.doesNotMatch(
      JSON.stringify([diagnostics, f.toasts]),
      /fixture-private-detail/,
    );
  }
});

test("unknown, huge and sensitive native errors never leave the local boundary", () => {
  for (const error of [
    undefined,
    null,
    "fixture-secret",
    { errMsg: "x".repeat(513) + " permission denied" },
    {
      errMsg:
        "https://work.weixin.qq.com/kfid/kf_fixture?token=fixture-secret ww1234567890abcdef wx_fixture 13800138000",
      token: "fixture-secret",
    },
    Object.defineProperty({}, "errMsg", {
      get() {
        throw new Error("fixture-secret");
      },
    }),
    {
      errMsg:
        "openCustomerServiceChat:fail transport https://provider.fixture/unsupported?token=errCode=123456",
    },
    {
      errMsg:
        "openCustomerServiceChat:fail permission denied token=fixture-secret errCode=123456",
    },
  ]) {
    const f = fixture(),
      diagnostics = [];
    openWecomCustomerService(contact, f.host, (value) =>
      diagnostics.push(value),
    );
    assert.doesNotThrow(() => f.calls[0].fail(error));
    assert.deepEqual(diagnostics[0], {
      stage: "SDK_CALLBACK",
      code: "NOT_PROVIDED",
      signal: "UNKNOWN",
    });
    assert.doesNotMatch(
      JSON.stringify([diagnostics, f.toasts]),
      /fixture-secret|weixin\.qq|ww123|wx_fixture|13800138000/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.toasts.length, 1);
  }
});

test("a broken diagnostic consumer cannot suppress fallback or retry a native call", () => {
  const f = fixture();
  openWecomCustomerService(contact, f.host, () => {
    throw new Error("fixture-private-detail");
  });
  assert.doesNotThrow(() => f.calls[0].fail({ errCode: 12 }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0].title, /未打开/);
});

test("only explicit superseded-attempt rejection discards a stale failure toast", () => {
  const f = fixture();
  openWecomCustomerService(contact, f.host, () => false);
  f.calls[0].fail({ errCode: 12 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.toasts.length, 0);
});

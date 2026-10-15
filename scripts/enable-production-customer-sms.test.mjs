import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { prepareCustomerSmsEnable } from "./enable-production-customer-sms.mjs";

const fixture = [
  "NODE_ENV=production",
  "AUTH_PROVIDER=wechat",
  "STAFF_BROWSER_LOGIN_ENABLED=true",
  "SMS_PROVIDER=aliyun",
  "SMS_SEND_ENABLED=false",
  "PHONE_VERIFICATION_SMS_ENABLED=false",
  "STAFF_PASSWORD_LOGIN_ENABLED=false",
  "ALIYUN_SMS_ACCESS_KEY_ID=LTAIfixture000000000000",
  "ALIYUN_SMS_ACCESS_KEY_SECRET=fixtureSecret000000000000",
  "ALIYUN_SMS_SIGN_NAME=测试专用",
  "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE=SMS_fixture",
  "WECHAT_PAY_PREPAY_ENABLED=true",
  "# preserve configuration",
  "",
].join("\n");

test("activates exactly the customer gates with a bounded shared daily limit", () => {
  const { raw, bytes } = prepareCustomerSmsEnable(Buffer.from(fixture), 20);
  for (const key of [
    "SMS_SEND_ENABLED",
    "PHONE_VERIFICATION_SMS_ENABLED",
    "CUSTOMER_SMS_LOGIN_ENABLED",
  ])
    assert.equal(raw[key], "true");
  assert.equal(raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT, "20");
  assert.equal(raw.STAFF_PASSWORD_LOGIN_ENABLED, "false");
  assert.equal(raw.WECHAT_PAY_PREPAY_ENABLED, "true");
  const before = parseEnv(fixture);
  for (const key of Object.keys(before))
    if (!["SMS_SEND_ENABLED", "PHONE_VERIFICATION_SMS_ENABLED"].includes(key))
      assert.equal(raw[key], before[key]);
  assert.ok(bytes.includes(Buffer.from("# preserve configuration\n")));
});
test("retains CRLF and unrelated bytes", () => {
  const { bytes } = prepareCustomerSmsEnable(
    Buffer.from(fixture.replaceAll("\n", "\r\n")),
    1,
  );
  assert.ok(
    bytes.includes(
      Buffer.from(
        "WECHAT_PAY_PREPAY_ENABLED=true\r\n# preserve configuration\r\n",
      ),
    ),
  );
  assert.equal(bytes.toString().replaceAll("\r\n", "").includes("\n"), false);
});
test("refuses missing credentials, duplicate keys and enabled unrelated channels", () => {
  for (const value of [
    fixture.replace(/ALIYUN_SMS_ACCESS_KEY_SECRET=.*\n/, ""),
    fixture + "SMS_PROVIDER=aliyun\n",
    fixture + "SAFETY_NOTIFICATION_DISPATCH_ENABLED=true\n",
    fixture.replace("SMS_SEND_ENABLED=false", "SMS_SEND_ENABLED=true"),
    fixture.replace(
      "STAFF_PASSWORD_LOGIN_ENABLED=false",
      "STAFF_PASSWORD_LOGIN_ENABLED=true",
    ),
    fixture.replace("AUTH_PROVIDER=wechat", "AUTH_PROVIDER=mock"),
    fixture + "unrecognized syntax\n",
    "\ufeff" + fixture,
  ])
    assert.throws(() => prepareCustomerSmsEnable(Buffer.from(value), 20));
});
test("requires explicit finite request limit", () => {
  for (const value of [undefined, 0, -1, 0.1, NaN, Infinity, 10001, "20"])
    assert.throws(() => prepareCustomerSmsEnable(Buffer.from(fixture), value));
  for (const value of [1, 20, 10000])
    assert.equal(
      prepareCustomerSmsEnable(Buffer.from(fixture), value).raw
        .PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT,
      String(value),
    );
});

import assert from "node:assert/strict";
// Browser smoke fixture only against the dedicated loopback test API.
const base = "http://127.0.0.1:3211/v1";
async function call(path: string, token = "", body?: object, key?: string) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  assert.ok(response.ok, `${path} ${response.status}`);
  return json.data;
}
const config = await call("/config/public");
assert.equal(config.operatingMode, "DEVELOPMENT");
assert.equal(config.integrations.payment, "mock");
const session = await call("/auth/wechat-miniapp", "", {
  code: "local-browser-refund-customer",
});
const service = (await call("/catalog/services"))[0];
const date = new Date(Date.now() + 8 * 3600_000 + 86400_000)
  .toISOString()
  .slice(0, 10);
const slot = (
  await call(`/availability/slots?serviceId=${service.id}&date=${date}`)
)[0];
assert.ok(slot);
const hold = await call("/booking-holds", session.accessToken, {
  serviceId: service.id,
  therapistId: slot.therapistId,
  startsAt: slot.startsAt,
});
const order = await call(
  "/orders",
  session.accessToken,
  {
    reservationId: hold.id,
    address: {
      contactName: "测试客户",
      phone: "13800000000",
      detail: "浏览器模拟验收地址",
    },
  },
  `browser-order-${Date.now()}`,
);
const intent = await call(
  `/orders/${order.id}/payment-intent`,
  session.accessToken,
  {},
);
await call(`/dev/payments/${intent.id}/succeed`, session.accessToken, {});
console.log(
  JSON.stringify({
    localMockOnly: true,
    orderNo: order.orderNo,
    paymentId: intent.id,
    organizationId: "org-zhongyuan-pilot",
  }),
);

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  pickSlotIndex,
  quoteDisplay,
  shanghaiDate,
} = require("../apps/miniapp/utils/booking.js");

const slot = (therapistId, startsAt) => ({
  therapistId,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
});

test("soon mode chooses the earliest real slot without inventing availability", () => {
  const slots = [
    slot("tech-b", "2026-10-08T04:00:00.000Z"),
    slot("tech-a", "2026-10-08T05:00:00.000Z"),
  ];
  assert.equal(pickSlotIndex(slots, "", "soon"), 0);
  assert.equal(pickSlotIndex(slots, "tech-a", "soon"), 1);
  assert.equal(pickSlotIndex(slots, "missing-tech", "soon"), -1);
  assert.equal(pickSlotIndex([], "", "soon"), -1);
});

test("scheduled mode requires an explicit slot unless a technician was selected", () => {
  const slots = [slot("tech-a", "2026-10-09T04:00:00.000Z")];
  assert.equal(pickSlotIndex(slots, "", "schedule"), -1);
  assert.equal(pickSlotIndex(slots, "tech-a", "schedule"), 0);
});

test("server quote fields are displayed in yuan with no client-side recalculation", () => {
  assert.deepEqual(
    quoteDisplay({
      reservationId: "hold-1",
      serviceAmountFen: 19_800,
      travelFeeFen: 0,
      discountFen: 1_500,
      payableFen: 18_300,
      currency: "CNY",
      moneyUnit: "fen",
    }),
    {
      serviceAmount: "198.00",
      travelFee: "0.00",
      discount: "15.00",
      payable: "183.00",
    },
  );
});

test("Shanghai booking dates do not depend on the device timezone", () => {
  assert.equal(
    shanghaiDate(0, Date.parse("2026-10-07T17:00:00.000Z")),
    "2026-10-08",
  );
  assert.equal(
    shanghaiDate(1, Date.parse("2026-10-07T17:00:00.000Z")),
    "2026-10-09",
  );
});

test("booking page uses a two-step server quote flow and discloses one-item limit", () => {
  const page = readFileSync(
    new URL("../apps/miniapp/pages/booking/index.wxml", import.meta.url),
    "utf8",
  );
  assert.match(page, /核对订单与价格/);
  assert.match(page, /最终金额由服务器核价/);
  assert.match(page, /当前预约系统每单支持 1 项服务/);
  assert.match(page, /尽快上门/);
  assert.match(page, /预约时间/);
  assert.match(page, /提交订单并支付/);
  assert.match(page, /立即打开微信支付/);
  assert.doesNotMatch(page, /创建订单不会自动扣款/);
  assert.doesNotMatch(page, /划线原价|虚构优惠/);
  assert.match(page, /免出行费（¥0\.00）/);
  const source = readFileSync(
    new URL("../apps/miniapp/pages/booking/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /quote\.travelFeeFen !== 0/);
  assert.match(source, /order\.travelFeeFen !== 0/);
});

test("created orders immediately prepare a verified WeChat payment and query the original result", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/booking/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const order = await api<OrderView>/);
  assert.match(source, /await this\.payCreatedOrder\(order\)/);
  assert.match(source, /`\/orders\/\$\{order\.id\}\/payment-intent`/);
  assert.match(source, /wx\.requestPayment/);
  assert.match(source, /`\/payments\/\$\{intent\.id\}\/reconcile`/);
  assert.match(source, /intent\.amountFen !== order\.payableFen/);
});

test("handwritten addresses are geocoded before quote and location/search remain available", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/booking/index.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../apps/miniapp/pages/booking/index.wxml", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/locations\/address-geocodes/);
  assert.match(source, /await this\.ensureAddressCoordinates\(\)/);
  assert.match(source, /fullAddress\(\)/);
  assert.doesNotMatch(source, /请先使用定位或高德地址搜索选择上门坐标/);
  assert.match(page, /可手动填写，也可用高德自动定位/);
  assert.match(page, /楼栋、单元、门牌号/);
  assert.match(page, /高德定位当前地址/);
});

test("customer order status keeps synchronizing from the shared backend while visible", () => {
  const orders = readFileSync(
    new URL("../apps/miniapp/pages/orders/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(orders, /setInterval\(\(\) => void this\.load\(true\), 5_000\)/);
  assert.match(orders, /onHide\(\)[\s\S]*stopOrderRefresh\(\)/);
  assert.match(orders, /onUnload\(\)[\s\S]*stopOrderRefresh\(\)/);
  assert.match(orders, /if \(loadInFlight\) return/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const fresh = (path) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  return require(resolved);
};

test("production miniapp targets the new mtsc API", () => {
  const app = readFileSync(
    new URL("../apps/miniapp/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /https:\/\/api\.mtsc\.top\/v1/);
  assert.doesNotMatch(
    app,
    /localhost|127\.0\.0\.1|\u5546\u57ce\u5347\u7ea7\u4e2d/,
  );
});

test("service, WeChat login and order submission stay on the customer flow", async () => {
  const calls = [];
  const storage = new Map();
  let captured;
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "https://api.mtsc.top/v1" },
  });
  globalThis.Page = (definition) => {
    captured = definition;
    definition.setData = (value) => Object.assign(definition.data, value);
  };
  globalThis.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: ({ success }) => success({ code: "real-one-time-code" }),
    showToast: () => undefined,
    switchTab: ({ url }) => calls.push({ path: url, method: "NAVIGATE" }),
    request: ({ url, method = "GET", data, header, success }) => {
      const path = url.replace("https://api.mtsc.top/v1", "");
      calls.push({ path, method, data, header });
      const responses = {
        "/catalog/services": [
          {
            id: "svc-neck-60",
            slug: "neck-relax-60",
            name: "\u80a9\u9888\u8212\u7f13",
            category: "MASSAGE",
            subtitle:
              "\u4e45\u5750\u4e4b\u540e\uff0c\u8ba9\u7d27\u7ef7\u6162\u6162\u677e\u5f00",
            description:
              "\u6b63\u89c4\u975e\u533b\u7597\u653e\u677e\u670d\u52a1",
            durationMinutes: 60,
            priceFen: 19800,
            featured: true,
            steps: [],
            boundaries: [],
          },
        ],
        "/auth/wechat-miniapp": {
          accessToken: "session-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          user: {
            id: "customer-1",
            role: "CUSTOMER",
            displayName: "\u5fae\u4fe1\u7528\u6237",
          },
        },
        "/booking-holds": {
          id: "hold-1",
          serviceId: "svc-neck-60",
          therapistId: "user-public-booking-capacity",
          startsAt: "2026-10-08T02:00:00.000Z",
          endsAt: "2026-10-08T03:00:00.000Z",
          expiresAt: "2026-10-08T01:55:00.000Z",
          status: "HOLD",
        },
        "/orders/quote": {
          reservationId: "hold-1",
          serviceAmountFen: 19800,
          travelFeeFen: 0,
          discountFen: 0,
          payableFen: 19800,
          currency: "CNY",
          moneyUnit: "fen",
        },
        "/orders": { id: "order-1" },
      };
      success({
        statusCode: path === "/orders" ? 201 : 200,
        data: { data: responses[path] },
      });
    },
  };

  fresh(
    fileURLToPath(
      new URL("../apps/miniapp/pages/services/index.js", import.meta.url),
    ),
  );
  await captured.onShow();
  assert.equal(captured.data.error, "");
  assert.equal(captured.data.services[0].name, "\u80a9\u9888\u8212\u7f13");

  fresh(
    fileURLToPath(
      new URL("../apps/miniapp/pages/booking/index.js", import.meta.url),
    ),
  );
  captured.setData({
    service: {
      id: "svc-neck-60",
      slug: "neck-relax-60",
      name: "\u80a9\u9888\u8212\u7f13",
      durationMinutes: 60,
      priceFen: 19800,
    },
    slots: [
      {
        therapistId: "user-public-booking-capacity",
        startsAt: "2026-10-08T02:00:00.000Z",
        endsAt: "2026-10-08T03:00:00.000Z",
      },
    ],
    selected: 0,
    contactName: "\u5f20\u5973\u58eb",
    phone: "13800138000",
    detail: "\u90d1\u5dde\u5e02\u91d1\u6c34\u533a\u6d4b\u8bd5\u8def 1 \u53f7",
    latitude: 34.76,
    longitude: 113.68,
    consent: true,
    addressVerificationRequired: false,
  });
  await captured.create();

  assert.equal(captured.data.error, "");
  assert.equal(storage.has("zydj.auth.session"), true);
  assert.deepEqual(
    calls.filter((item) => item.path.startsWith("/")).map((item) => item.path),
    [
      "/catalog/services",
      "/auth/wechat-miniapp",
      "/booking-holds",
      "/orders/quote",
      "/orders",
      "/pages/orders/index",
    ],
  );
  const order = calls.find((item) => item.path === "/orders");
  assert.match(order.header.Authorization, /^Bearer /);
  assert.match(order.header["Idempotency-Key"], /^miniapp-/);
  assert.equal(order.data.address.coordinateSystem, "GCJ-02");
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { PrismaClient, type UserRole } from "@prisma/client";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";

const databaseUrl = process.env.MALL_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set MALL_TEST_DATABASE_URL to an isolated local zhongyuan_daojia_test database",
  );
const target = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !(
    target.pathname === "/zhongyuan_daojia_test" ||
    (process.env.CONFIRM_PRIVATE_ACCEPTANCE_TEST === "true" &&
      target.pathname === "/zydj_acceptance_smoke" &&
      target.username === "zydj_acceptance")
  )
)
  throw new Error("Only the dedicated local test database is allowed");
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";
process.env.AUTH_PROVIDER = "mock";
process.env.PAYMENT_PROVIDER = "mock";
// This legacy workflow isolates business tests; MFA enforcement has its own real HTTP verifier.
process.env.STAFF_MFA_REQUIRED = "false";
process.env.WECHAT_PAY_REFUND_ENABLED = "false";
process.env.WECHAT_PAY_PREPAY_ENABLED = "false";
process.env.WECHAT_PAY_RECOVERY_ENABLED = "false";
process.env.AUTH_SESSION_PEPPER = `test-only-${randomUUID()}`;
process.env.DATA_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 1).toString("base64");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
  rawBody: true,
  logger: false,
});
app.setGlobalPrefix("v1");
await app.listen(0, "127.0.0.1");
const base = `${await app.getUrl()}/v1`;
const crypto = new AuthCryptoService(app.get(ConfigService));
const appId = app.get(ConfigService).get("WECHAT_MINIAPP_APP_ID");
const prefix = `mall-test-${randomUUID()}`;
const userIds: string[] = [];
let organizationId: string | undefined;
let passed = false;
const checks: string[] = [];

async function call<T = any>(
  path: string,
  token = "",
  body?: unknown,
  key?: string,
  expected = 200,
) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: expected ${expected}, received ${response.status}: ${JSON.stringify(json)}`,
  );
  return json.data as T;
}
async function identity(role: UserRole, suffix: string) {
  const code = `${prefix}-${suffix}`;
  const openId = `mock-${createHash("sha256").update(code).digest("hex").slice(0, 32)}`;
  const user = await prisma.user.create({
    data: {
      role,
      displayName: suffix,
      ...(role === "CUSTOMER"
        ? {}
        : {
            organizationId,
            memberships: { create: { organizationId: organizationId!, role } },
          }),
      identities: {
        create: {
          provider: "WECHAT_MINIAPP",
          subjectHash: crypto.hashIdentity(appId, openId),
          subjectEncrypted: crypto.encrypt(openId),
        },
      },
    },
  });
  userIds.push(user.id);
  const session = await call("/auth/wechat-miniapp", "", { code });
  assert.equal(session.user.id, user.id);
  assert.ok(session.accessToken.length >= 32);
  return { user, token: session.accessToken, code };
}

try {
  organizationId = (
    await prisma.organization.create({ data: { name: prefix } })
  ).id;
  const customer = await identity("CUSTOMER", "customer");
  const stranger = await identity("CUSTOMER", "stranger");
  const applicant = await identity("FINANCE_REQUESTER", "applicant");
  const reviewer = await identity("FINANCE_APPROVER", "reviewer");
  const dispatcher = await identity("DISPATCHER", "dispatcher");
  const therapist = await identity("THERAPIST", "therapist");
  await call("/auth/me", customer.token);
  await call("/orders", "", undefined, undefined, 401);
  await prisma.user.update({
    where: { id: stranger.user.id },
    data: { status: "SUSPENDED" },
  });
  await call(
    "/auth/wechat-miniapp",
    "",
    { code: stranger.code },
    undefined,
    401,
  );
  await prisma.user.update({
    where: { id: stranger.user.id },
    data: { status: "ACTIVE" },
  });
  checks.push("login, unauthorized and disabled-account guards");

  const service = await prisma.service.create({
    data: {
      organizationId,
      slug: prefix,
      name: "自动化 SPA 服务",
      category: "SPA_RELAXATION",
      subtitle: "非医疗测试服务",
      description: "仅用于本地自动化测试",
      priceFen: 19880n,
      durationMinutes: 60,
      published: true,
      steps: ["测试"],
      boundaries: ["非医疗"],
    },
  });
  assert.ok(
    (await call("/catalog/services")).some(
      (item: any) => item.id === service.id,
    ),
  );
  assert.equal((await call(`/catalog/services/${prefix}`)).priceFen, 19880);
  const date = new Date(Date.now() + 8 * 3600_000 + 2 * 86400_000)
    .toISOString()
    .slice(0, 10);
  await call(
    "/admin/scheduling/shifts",
    dispatcher.token,
    {
      organizationId,
      therapistId: therapist.user.id,
      startsAt: `${date}T10:00:00+08:00`,
      endsAt: `${date}T18:00:00+08:00`,
    },
    undefined,
    201,
  );
  const slots = await call(
    `/availability/slots?serviceId=${service.id}&date=${date}`,
  );
  assert.ok(slots.length > 1);
  const hold = await call(
    "/booking-holds",
    customer.token,
    {
      serviceId: service.id,
      therapistId: therapist.user.id,
      startsAt: slots[0].startsAt,
    },
    undefined,
    201,
  );
  assert.equal(
    (
      await call(
        "/orders/quote",
        customer.token,
        { reservationId: hold.id },
        undefined,
        201,
      )
    ).payableFen,
    19880,
  );
  const orderBody = {
    reservationId: hold.id,
    address: {
      contactName: "测试客户",
      phone: "13800000000",
      detail: "仅本地自动化测试地址",
    },
  };
  await call(
    "/orders",
    customer.token,
    { ...orderBody, payableFen: 1 },
    `${prefix}-invalid`,
    400,
  );
  const orderKey = `${prefix}-order`;
  const created = await Promise.all([
    call("/orders", customer.token, orderBody, orderKey, 201),
    call("/orders", customer.token, orderBody, orderKey, 201),
  ]);
  const order = created[0];
  assert.equal(order.id, created[1].id);
  await call(`/orders/${order.id}`, stranger.token, undefined, undefined, 403);
  assert.equal((await call("/orders", customer.token))[0].id, order.id);
  const encrypted = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
  });
  assert.ok(!encrypted.addressEncrypted.includes("测试地址"));
  checks.push(
    "published catalog/detail, slots, quote, encrypted address and concurrent idempotent ordering",
  );

  const runtimeConfig = app.get(ConfigService);
  runtimeConfig.set("PAYMENT_PROVIDER", "wechat");
  try {
    await call(
      `/orders/${order.id}/payment-intent`,
      customer.token,
      {},
      undefined,
      503,
    );
    assert.equal(
      await prisma.payment.count({ where: { orderId: order.id } }),
      0,
    );
  } finally {
    runtimeConfig.set("PAYMENT_PROVIDER", "mock");
  }
  checks.push(
    "real HTTP WeChat prepay routing and closed gate create no payment/no channel POST",
  );
  const intents = await Promise.all([
    call(
      `/orders/${order.id}/payment-intent`,
      customer.token,
      {},
      undefined,
      201,
    ),
    call(
      `/orders/${order.id}/payment-intent`,
      customer.token,
      {},
      undefined,
      201,
    ),
  ]);
  assert.equal(intents[0].id, intents[1].id);
  const paymentId = intents[0].id;
  await Promise.all([
    call(
      `/dev/payments/${paymentId}/succeed`,
      customer.token,
      {},
      undefined,
      201,
    ),
    call(
      `/dev/payments/${paymentId}/succeed`,
      customer.token,
      {},
      undefined,
      201,
    ),
  ]);
  assert.equal(
    (await call(`/orders/${order.id}`, customer.token)).status,
    "PAID",
  );
  assert.equal(
    await prisma.paymentEvent.count({
      where: { paymentId, type: "MOCK_PAYMENT_SUCCEEDED" },
    }),
    1,
  );
  checks.push("concurrent mock payment intent and exactly-once success");

  const path = `/admin/organizations/${organizationId}`;
  await call(
    `${path}/payments/${paymentId}/refunds`,
    applicant.token,
    { reason: "CUSTOMER_CANCELLED", amountFen: 999999 },
    `${prefix}-invalid-refund`,
    400,
  );
  const refundKey = `${prefix}-refund`;
  const requests = await Promise.all([
    call(
      `${path}/payments/${paymentId}/refunds`,
      applicant.token,
      { reason: "CUSTOMER_CANCELLED" },
      refundKey,
      201,
    ),
    call(
      `${path}/payments/${paymentId}/refunds`,
      applicant.token,
      { reason: "CUSTOMER_CANCELLED" },
      refundKey,
      201,
    ),
  ]);
  const rejected = requests[0];
  assert.equal(rejected.id, requests[1].id);
  assert.equal(rejected.amountFen, 19880);
  await assert.rejects(
    prisma.refund.update({
      where: { id: rejected.id },
      data: { status: "PROCESSING" },
    }),
  );
  await assert.rejects(
    prisma.refund.update({
      where: { id: rejected.id },
      data: { reviewedById: applicant.user.id },
    }),
  );
  await assert.rejects(
    prisma.payment.update({
      where: { id: paymentId },
      data: { refundReservedFen: 1n },
    }),
  );
  await call(
    `${path}/payments/${paymentId}/refunds`,
    applicant.token,
    { reason: "UNFULFILLABLE" },
    refundKey,
    409,
  );
  await call(
    `${path}/payments/${paymentId}/refunds`,
    applicant.token,
    { reason: "CUSTOMER_CANCELLED" },
    `${prefix}-excess`,
    409,
  );
  // Give applicant approver role too: identity separation must still forbid self-review.
  await prisma.staffMembership.create({
    data: {
      organizationId,
      userId: applicant.user.id,
      role: "FINANCE_APPROVER",
    },
  });
  await call(
    `${path}/refunds/${rejected.id}/approve`,
    applicant.token,
    { code: "CONFIRMED" },
    undefined,
    403,
  );
  await call(`${path}/refunds/${rejected.id}/reject`, reviewer.token, {
    code: "INSUFFICIENT_EVIDENCE",
  });
  assert.equal(
    (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }))
      .refundReservedFen,
    0n,
  );
  const ownKey = `${prefix}-own-refund`;
  const refund = await call(
    `/orders/${order.id}/refunds`,
    customer.token,
    {},
    ownKey,
    201,
  );
  await call(
    `/orders/${order.id}/refunds`,
    stranger.token,
    {},
    `${prefix}-stranger`,
    403,
  );
  await call(`${path}/refunds/${refund.id}/approve`, reviewer.token, {
    code: "CONFIRMED",
  });
  await call(`${path}/refunds/${refund.id}/submit`, reviewer.token, {});
  await Promise.all([
    call(
      `/dev/organizations/${organizationId}/refunds/${refund.id}/succeed`,
      reviewer.token,
      {},
    ),
    call(
      `/dev/organizations/${organizationId}/refunds/${refund.id}/succeed`,
      reviewer.token,
      {},
    ),
  ]);
  const settled = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
  });
  assert.equal(settled.refundedFen, 19880n);
  assert.equal(settled.refundReservedFen, 0n);
  assert.equal(settled.status, "REFUNDED");
  assert.equal(
    await prisma.refundLedgerPosting.count({ where: { refundId: refund.id } }),
    1,
  );
  assert.equal(
    (await call(`/orders/${order.id}`, customer.token)).status,
    "REFUNDED",
  );
  assert.equal(
    (await call(`/orders/${order.id}/refunds`, customer.token, {}, ownKey, 201))
      .id,
    refund.id,
  );
  const history = await call(
    `${path}/payments/${paymentId}/refunds`,
    reviewer.token,
  );
  assert.ok(
    history.some((row: any) =>
      row.events.some((event: any) => event.type === "REFUND_SUCCEEDED"),
    ),
  );
  await call(
    `${path}/payments/${paymentId}/refunds`,
    applicant.token,
    { reason: "CUSTOMER_CANCELLED" },
    `${prefix}-after-success`,
    409,
  );
  await assert.rejects(
    prisma.payment.update({
      where: { id: paymentId },
      data: { refundedFen: 99999n },
    }),
  );
  await assert.rejects(
    prisma.refundLedgerPosting.updateMany({
      where: { refundId: refund.id },
      data: { amountFen: 1n },
    }),
  );
  checks.push(
    "refund strict schema, quota, duplicate/concurrent requests, self-review prohibition, rejection release, own application, concurrent success, history and database constraints",
  );

  const remainingSlots = await call(
    `/availability/slots?serviceId=${service.id}&date=${date}`,
  );
  const cancelHold = await call(
    "/booking-holds",
    customer.token,
    {
      serviceId: service.id,
      therapistId: therapist.user.id,
      startsAt: remainingSlots[0].startsAt,
    },
    undefined,
    201,
  );
  const cancelOrder = await call(
    "/orders",
    customer.token,
    { ...orderBody, reservationId: cancelHold.id },
    `${prefix}-cancel-order`,
    201,
  );
  assert.equal(
    (
      await call(
        `/payments/orders/${cancelOrder.id}/close`,
        customer.token,
        {},
        undefined,
        200,
      )
    ).order.status,
    "CANCELLED",
  );
  await call(
    `/orders/${cancelOrder.id}/payment-intent`,
    customer.token,
    {},
    undefined,
    409,
  );
  // Protect the alternate booking cleanup path from releasing an uncertain WeChat payment.
  await prisma.order.update({
    where: { id: cancelOrder.id },
    data: {
      status: "PENDING_PAYMENT",
      paymentExpiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 900_000),
    },
  });
  await prisma.appointmentReservation.update({
    where: { id: cancelHold.id },
    data: {
      status: "HOLD",
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 900_000),
    },
  });
  const protectedPayment = await prisma.payment.create({
    data: {
      orderId: cancelOrder.id,
      provider: "WECHAT",
      merchantPaymentNo: `PAY${randomUUID().replaceAll("-", "").slice(0, 25)}`,
      amountFen: BigInt(cancelOrder.payableFen),
    },
  });
  await call(
    `/payments/orders/${cancelOrder.id}/close`,
    "",
    {},
    undefined,
    401,
  );
  await call(
    `/payments/orders/${cancelOrder.id}/close`,
    stranger.token,
    {},
    undefined,
    403,
  );
  // Provider mode is restored immediately; gate stays closed and performs no channel action.
  runtimeConfig.set("PAYMENT_PROVIDER", "wechat");
  try {
    await call(
      `/payments/orders/${cancelOrder.id}/close`,
      customer.token,
      {},
      undefined,
      503,
    );
  } finally {
    runtimeConfig.set("PAYMENT_PROVIDER", "mock");
  }
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: protectedPayment.id },
      })
    ).closeRequestedAt,
    null,
  );
  const protectedSlots = await call(
    `/availability/slots?serviceId=${service.id}&date=${date}`,
  );
  assert.ok(
    !protectedSlots.some(
      (slot: any) =>
        slot.therapistId === therapist.user.id &&
        slot.startsAt === cancelHold.startsAt,
    ),
  );
  await call(
    "/booking-holds",
    customer.token,
    {
      serviceId: service.id,
      therapistId: therapist.user.id,
      startsAt: cancelHold.startsAt,
    },
    undefined,
    409,
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: cancelOrder.id } }))
      .status,
    "PENDING_PAYMENT",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: cancelHold.id },
      })
    ).status,
    "HOLD",
  );
  // Restore only this script's synthetic fixture so later page tests can use the same test timetable.
  await prisma.payment.update({
    where: { id: protectedPayment.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  await prisma.order.update({
    where: { id: cancelOrder.id },
    data: { status: "CANCELLED" },
  });
  await prisma.appointmentReservation.update({
    where: { id: cancelHold.id },
    data: { status: "RELEASED" },
  });
  checks.push(
    "expired pending WeChat holds stay unavailable and cannot be released by a new booking's cleanup",
  );
  await call("/auth/logout", customer.token, {});
  await call("/auth/me", customer.token, undefined, undefined, 401);
  checks.push(
    "unpaid cancellation, forbidden post-cancel payment, logout revocation",
  );

  // Execute the compiled native miniapp pages with a wx transport shim against the same real HTTP API.
  // This verifies page logic, not WeChat rendering/device capabilities.
  const storage = new Map<string, unknown>();
  const require = createRequire(import.meta.url);
  let captured: any;
  const globals = globalThis as any;
  const previous = {
    wx: globals.wx,
    Page: globals.Page,
    getApp: globals.getApp,
  };
  globals.Page = (options: any) => {
    captured = {
      ...options,
      data: structuredClone(options.data),
      setData(data: object) {
        Object.assign(this.data, data);
      },
    };
  };
  globals.getApp = () => ({ globalData: { apiBaseUrl: base } });
  globals.wx = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    login: (options: any) => options.success({ code: customer.code }),
    showToast: () => {},
    navigateTo: () => {},
    switchTab: () => {},
    showModal: (options: any) => options.success({ confirm: true }),
    request: (options: any) => {
      void fetch(options.url, {
        method: options.method,
        headers: options.header,
        ...(options.method === "POST"
          ? { body: JSON.stringify(options.data ?? {}) }
          : {}),
      })
        .then(async (response) =>
          options.success({
            statusCode: response.status,
            data: await response.json(),
          }),
        )
        .catch(() => options.fail({ errMsg: "test request failed" }));
    },
  };
  try {
    require("../../miniapp/pages/services/index.js");
    const catalogPage = captured;
    await catalogPage.onShow();
    assert.equal(catalogPage.data.error, "");
    assert.ok(
      catalogPage.data.services.some((row: any) => row.id === service.id),
    );
    require("../../miniapp/pages/booking/index.js");
    const booking = captured;
    await booking.onLoad({ slug: prefix });
    booking.setData({ date, selected: -1 });
    await booking.loadSlots();
    booking.setData({
      selected: 0,
      contactName: "测试客户",
      phone: "13800000000",
      detail: "小程序运行逻辑测试地址",
      consent: true,
    });
    await booking.create();
    assert.equal(booking.data.error, "");
    require("../../miniapp/pages/orders/index.js");
    const orderPage = captured;
    await orderPage.onShow();
    assert.equal(orderPage.data.error, "");
    const pending = orderPage.data.orders.find(
      (row: any) => row.status === "PENDING_PAYMENT",
    );
    assert.ok(pending);
    await orderPage.action({
      currentTarget: { dataset: { id: pending.id, action: "pay" } },
    });
    assert.equal(orderPage.data.error, "");
    assert.equal(
      orderPage.data.orders.find((row: any) => row.id === pending.id).status,
      "PAID",
    );
    await orderPage.action({
      currentTarget: { dataset: { id: pending.id, action: "refund" } },
    });
    assert.equal(orderPage.data.error, "");
    assert.equal(
      orderPage.data.orders.find((row: any) => row.id === pending.id).refunds[0]
        .status,
      "REQUESTED",
    );
    checks.push(
      "compiled miniapp catalog, booking, login, payment and own refund page logic against HTTP",
    );
    // Isolated SDK callbacks/transport substitutes: no wx.requestPayment is run on a real device.
    let sdkCalls = 0,
      reconcileCalls = 0;
    let sdkMode = "success",
      ready = true;
    const virtualOrder = {
      ...pending,
      id: "page-wechat",
      status: "PENDING_PAYMENT",
    };
    globals.wx.requestPayment = (options: any) => {
      sdkCalls++;
      assert.equal(options.signType, "RSA");
      assert.equal(options.package, "prepay_id=wx-local-page");
      if (sdkMode === "success") options.success();
      else
        options.fail({
          errMsg:
            sdkMode === "cancel"
              ? "requestPayment:fail cancel"
              : "requestPayment:fail test",
        });
    };
    const liveRequest = globals.wx.request;
    globals.wx.request = (options: any) => {
      const path = new URL(options.url).pathname.replace(/^\/v1/, "");
      if (path.startsWith("/dev/payments/"))
        throw new Error("WeChat page must never confirm mock success");
      let data: any;
      if (path === "/orders/page-wechat/payment-intent")
        data = {
          id: "page-payment",
          orderId: "page-wechat",
          provider: "WECHAT",
          status: "PENDING",
          amountFen: 19880,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          mockConfirmationAvailable: false,
          prepayState: ready ? "READY" : "UNKNOWN",
          ...(ready
            ? {
                wechatPayParameters: {
                  timeStamp: "123",
                  nonceStr: "local",
                  package: "prepay_id=wx-local-page",
                  signType: "RSA",
                  paySign: "test-placeholder",
                },
              }
            : {}),
        };
      else if (path === "/payments/page-payment/reconcile") {
        reconcileCalls++;
        data = { status: "PENDING", providerState: "NOTPAY" };
      } else if (path === "/orders") data = [virtualOrder];
      else if (path === "/orders/page-wechat/refunds") data = [];
      else {
        liveRequest(options);
        return;
      }
      options.success({ statusCode: 200, data: { data } });
    };
    for (const mode of ["success", "cancel", "failure"]) {
      sdkMode = mode;
      await orderPage.action({
        currentTarget: { dataset: { id: "page-wechat", action: "pay" } },
      });
      assert.equal(orderPage.data.error, "");
      assert.equal(orderPage.data.orders[0].status, "PENDING_PAYMENT");
    }
    assert.equal(sdkCalls, 3);
    assert.equal(reconcileCalls, 3);
    ready = false;
    await orderPage.action({
      currentTarget: { dataset: { id: "page-wechat", action: "pay" } },
    });
    assert.equal(sdkCalls, 3);
    assert.equal(reconcileCalls, 4);
    assert.match(orderPage.data.error, /结果未确认/);
    assert.equal(orderPage.data.orders[0].status, "PENDING_PAYMENT");
    checks.push(
      "compiled WeChat page SDK success/cancel/failure and UNKNOWN use server query, never local settlement or mock confirmation (isolated SDK/transport fixtures)",
    );
  } finally {
    globals.wx = previous.wx;
    globals.Page = previous.Page;
    globals.getApp = previous.getApp;
  }
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks,
      mode: "local isolated HTTP + PostgreSQL; no real WeChat funds",
    }),
  );
} finally {
  await app.close();
  if (organizationId)
    await prisma.$transaction(async (tx) => {
      const orderScope = { order: { organizationId } };
      const refundScope = { refund: { payment: orderScope } };
      await tx.refundLedgerPosting.deleteMany({ where: refundScope });
      await tx.refundEvent.deleteMany({ where: refundScope });
      await tx.refund.deleteMany({ where: { payment: orderScope } });
      await tx.paymentEvent.deleteMany({ where: { payment: orderScope } });
      await tx.payment.deleteMany({ where: orderScope });
      const rows = await tx.order.findMany({
        where: { organizationId },
        select: { id: true },
      });
      await tx.outboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateId: { in: rows.map((row) => row.id) } },
            { payload: { path: ["refundId"], string_starts_with: prefix } },
          ],
        },
      });
      await tx.orderEvent.deleteMany({ where: orderScope });
      await tx.orderItem.deleteMany({ where: orderScope });
      await tx.order.deleteMany({ where: { organizationId } });
      await tx.appointmentReservation.deleteMany({ where: { organizationId } });
      await tx.therapistShift.deleteMany({ where: { organizationId } });
      await tx.service.deleteMany({ where: { organizationId } });
      await tx.auditLog.deleteMany({
        where: { OR: [{ organizationId }, { actorId: { in: userIds } }] },
      });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.delete({ where: { id: organizationId } });
    });
  await prisma.$disconnect();
  console.log(JSON.stringify({ syntheticFixturesRemoved: true, passed }));
}

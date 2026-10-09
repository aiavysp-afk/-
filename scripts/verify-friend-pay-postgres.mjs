import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";

// This script must never infer or reuse a production DATABASE_URL.
const fixtureUrl = process.env.FRIEND_PAY_TEST_DATABASE_URL;
let parsedUrl;
try {
  parsedUrl = new URL(fixtureUrl ?? "");
} catch {
  // Invalid/missing values fail before importing Prisma or opening a connection.
}
if (
  !parsedUrl ||
  !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
  parsedUrl.hostname !== "127.0.0.1" ||
  parsedUrl.port !== "55432" ||
  parsedUrl.pathname !== "/friend_pay_tests" ||
  parsedUrl.username !== "friend_pay_test" ||
  parsedUrl.password !== "friend_pay_fixture_only" ||
  parsedUrl.search ||
  parsedUrl.hash
) {
  console.error(
    "FRIEND_PAY_POSTGRES_REFUSED: set FRIEND_PAY_TEST_DATABASE_URL only for the isolated 127.0.0.1:55432/friend_pay_tests fixture.",
  );
  process.exit(1);
}

const apiRequire = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { ConfigService } = apiRequire("@nestjs/config");
const { PrismaService } = await import(
  "../apps/api/dist/database/prisma.service.js"
);
const { AuthCryptoService } = await import(
  "../apps/api/dist/auth/auth-crypto.service.js"
);
const { AccessControlService } = await import(
  "../apps/api/dist/auth/access-control.service.js"
);
const { OrderStateMachine } = await import(
  "../apps/api/dist/orders/order-state-machine.js"
);
const { OrdersService } = await import(
  "../apps/api/dist/orders/orders.service.js"
);
const { PaymentGatewayService } = await import(
  "../apps/api/dist/payments/payment-gateway.service.js"
);
const { WechatPrepayService } = await import(
  "../apps/api/dist/payments/wechat-prepay.service.js"
);
const { WechatPaymentsService } = await import(
  "../apps/api/dist/payments/wechat-payments.service.js"
);
const { FriendPaymentsService } = await import(
  "../apps/api/dist/payments/friend-payments.service.js"
);
const { RefundsService } = await import(
  "../apps/api/dist/payments/refunds.service.js"
);
const { decodeWechatNotification } = await import(
  "../apps/api/dist/payments/wechat-pay.protocol.js"
);

const runId = `friend-fixture-${randomUUID()}`;
const ids = Object.fromEntries(
  [
    "org",
    "owner",
    "friendA",
    "friendB",
    "stranger",
    "therapist",
    "service",
  ].map((name) => [name, `${runId}-${name}`]),
);
const appId = "friend-fixture-app";
const merchantId = "friend-fixture-merchant";
const openIds = Object.fromEntries(
  ["owner", "friendA", "friendB", "stranger"].map((name) => [
    ids[name],
    `${runId}-openid-${name}`,
  ]),
);
const config = new ConfigService({
  NODE_ENV: "test",
  PAYMENT_PROVIDER: "wechat",
  WECHAT_MINIAPP_APP_ID: appId,
  WECHAT_MCH_ID: merchantId,
  WECHAT_PAY_NOTIFY_URL: "https://fixture.invalid/payments/wechat/notify",
  BRAND_NAME: "中原到家隔离代付测试",
  DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
  AUTH_SESSION_PEPPER: randomBytes(32).toString("hex"),
});
const prisma = new PrismaService({ datasources: { db: { url: fixtureUrl } } });
const crypto = new AuthCryptoService(config);
const stateMachine = new OrderStateMachine();
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const verifier = {
  appId,
  merchantId,
  publicKeyId: "PUB_KEY_ID_FRIEND_FIXTURE_ONLY",
  publicKeyPem: keys.publicKey,
  apiV3Key: randomBytes(16).toString("hex"),
};
const prepayRequests = [];
const queryRequests = [];
const client = {
  assertPrepayEnabled() {},
  verifierConfig: () => verifier,
  decodeNotification: (body, headers) =>
    decodeWechatNotification(body, headers, verifier),
  async prepay(request) {
    prepayRequests.push(request);
    // Confirm the claim committed before the simulated remote call; never call a real payment API.
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { merchantPaymentNo: request.out_trade_no },
    });
    assert.equal(
      payment.kind,
      "FRIEND",
      "Prepay must have a committed FRIEND claim",
    );
    assert.equal(
      payment.payerOpenIdHash,
      crypto.hashIdentity(appId, request.payer.openid),
      "Prepay payer binding must commit before external I/O",
    );
    assert.equal(
      openIds[payment.payerUserId],
      request.payer.openid,
      "Prepay cannot use the owner's identity",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `fixture-prepay-${payment.id}`;
  },
  paymentParameters(prepayId) {
    return {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: "fixture-only-no-live-sdk-call",
      package: `prepay_id=${prepayId}`,
      signType: "RSA",
      paySign: "fixture-only-not-a-live-wechat-signature",
    };
  },
  async queryTransaction(merchantPaymentNo) {
    queryRequests.push(merchantPaymentNo);
    throw new Error("Unexpected query: fixture never contacts WeChat");
  },
};
const prepay = new WechatPrepayService(
  prisma,
  config,
  crypto,
  new PaymentGatewayService(config),
  client,
);
const wechat = new WechatPaymentsService(
  prisma,
  client,
  { applyIfPresent: async () => false },
  crypto,
);
const friends = new FriendPaymentsService(
  prisma,
  config,
  client,
  prepay,
  wechat,
);
const refunds = new RefundsService(
  prisma,
  new AccessControlService(config),
  config,
  client,
  stateMachine,
);
const orders = new OrdersService(prisma, crypto, stateMachine, {});
const principal = (name) => ({
  userId: ids[name],
  sessionId: `${runId}-session-${name}`,
  displayName: `隔离测试 ${name}`,
  memberships: [],
});

function signedNotification(transaction, eventId) {
  const nonce = randomBytes(6).toString("hex");
  const associatedData = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(verifier.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const body = Buffer.from(
    JSON.stringify({
      id: eventId,
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: {
        original_type: "transaction",
        algorithm: "AEAD_AES_256_GCM",
        nonce,
        associated_data: associatedData,
        ciphertext: encrypted.toString("base64"),
      },
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = Buffer.concat([
    Buffer.from(`${timestamp}\n${nonce}\n`),
    body,
    Buffer.from("\n"),
  ]);
  return {
    body,
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": nonce,
      "wechatpay-serial": verifier.publicKeyId,
      "wechatpay-signature": sign(
        "RSA-SHA256",
        message,
        keys.privateKey,
      ).toString("base64"),
    },
  };
}

function transaction(payment, payerUserId, suffix) {
  return {
    appid: appId,
    mchid: merchantId,
    out_trade_no: payment.merchantPaymentNo,
    transaction_id: `${runId}-transaction-${suffix}`,
    trade_type: "JSAPI",
    trade_state: "SUCCESS",
    success_time: new Date().toISOString(),
    amount: { total: Number(payment.amountFen), currency: "CNY" },
    payer: { openid: openIds[payerUserId] },
  };
}

async function createOrder(suffix, appointmentOffset) {
  const expiresAt = new Date(Date.now() + 900000);
  const startsAt = new Date(Date.now() + appointmentOffset);
  const endsAt = new Date(startsAt.getTime() + 7200000);
  const reservation = await prisma.appointmentReservation.create({
    data: {
      id: `${runId}-reservation-${suffix}`,
      organizationId: ids.org,
      serviceId: ids.service,
      therapistId: ids.therapist,
      customerId: ids.owner,
      serviceAmountFen: 49800n,
      startsAt,
      endsAt,
      expiresAt,
    },
  });
  return prisma.order.create({
    data: {
      id: `${runId}-order-${suffix}`,
      orderNo: `${runId}-number-${suffix}`,
      organizationId: ids.org,
      customerId: ids.owner,
      therapistId: ids.therapist,
      reservationId: reservation.id,
      status: "PENDING_PAYMENT",
      appointmentStart: startsAt,
      appointmentEnd: endsAt,
      serviceAmountFen: 49800n,
      travelFeeFen: 0n,
      discountFen: 0n,
      payableFen: 49800n,
      addressEncrypted: crypto.encrypt(
        JSON.stringify({ addressLine: "隔离虚构测试地址，不是真实客户资料" }),
      ),
      policyVersion: "friend-fixture-only",
      paymentExpiresAt: expiresAt,
      idempotencyKey: `${runId}-create-${suffix}`,
      requestFingerprint: `${runId}-fingerprint-${suffix}`,
      items: {
        create: {
          serviceId: ids.service,
          serviceName: "隔离测试法式 SPA",
          durationMinutes: 120,
          unitPriceFen: 49800n,
          quantity: 1,
        },
      },
    },
  });
}

async function snapshot(orderId) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { reservation: true, payment: true },
  });
  return {
    order,
    events: await prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
    }),
    paymentEvents: await prisma.paymentEvent.findMany({
      where: { payment: { orderId } },
      orderBy: { id: "asc" },
    }),
    outbox: await prisma.outboxEvent.findMany({
      where: { aggregateId: orderId },
      orderBy: { id: "asc" },
    }),
    audit: await prisma.auditLog.findMany({
      where: { organizationId: ids.org },
      orderBy: { id: "asc" },
    }),
  };
}

async function assertStatusRejected(callback, status, description) {
  await assert.rejects(
    callback,
    (error) => error?.getStatus?.() === status,
    description,
  );
}

try {
  const [database] =
    await prisma.$queryRaw`SELECT current_database() AS database`;
  assert.equal(
    database.database,
    "friend_pay_tests",
    "Connected database must be the isolated fixture",
  );
  const migrations =
    await prisma.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name LIKE '%friend_payments'`;
  assert.equal(
    migrations.length,
    1,
    "Friend payment migration must already be deployed",
  );
  await prisma.organization.create({
    data: { id: ids.org, name: "隔离测试服务商户" },
  });
  for (const name of ["owner", "friendA", "friendB", "stranger", "therapist"]) {
    await prisma.user.create({
      data: {
        id: ids[name],
        role: name === "therapist" ? "THERAPIST" : "CUSTOMER",
        displayName: `隔离测试 ${name}`,
        organizationId: ids.org,
      },
    });
    if (openIds[ids[name]]) {
      await prisma.externalIdentity.create({
        data: {
          id: `${runId}-identity-${name}`,
          userId: ids[name],
          provider: "WECHAT_MINIAPP",
          subjectHash: crypto.hashIdentity(appId, openIds[ids[name]]),
          subjectEncrypted: crypto.encrypt(openIds[ids[name]]),
        },
      });
    }
  }
  await prisma.service.create({
    data: {
      id: ids.service,
      organizationId: ids.org,
      slug: `${runId}-spa`,
      name: "隔离测试法式 SPA",
      category: "SPA_RELAXATION",
      subtitle: "仅用于事务测试",
      description: "虚构项目，不用于正式服务",
      durationMinutes: 120,
      priceFen: 49800n,
      steps: [],
      boundaries: ["隔离测试，不进行真实付款"],
    },
  });
  const first = await createOrder("race", 3600000);
  const share = await friends.createShare(principal("owner"), first.id);
  const storedShare = await prisma.friendPaymentShare.findFirstOrThrow({
    where: { orderId: first.id },
  });
  assert.notEqual(
    storedShare.tokenHash,
    share.token,
    "Share capability must not be persisted in plaintext",
  );
  const summary = await friends.summary(principal("friendA"), share.token);
  assert.equal(
    summary.canPay,
    true,
    "Real pending fixture order must support friend pay",
  );
  assert.equal(
    JSON.stringify(summary).includes(first.orderNo),
    false,
    "Shared summary must not disclose order number",
  );
  assert.equal(
    JSON.stringify(summary).includes("addressEncrypted"),
    false,
    "Shared summary must not disclose address",
  );
  const competitors = ["friendA", "friendB"];
  const results = await Promise.allSettled(
    competitors.map((name) =>
      friends.createIntent(principal(name), share.token),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    "Only one competing friend may claim the prepay",
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
    "The other friend's competing claim must be rejected",
  );
  assert.equal(
    prepayRequests.length,
    1,
    "Competing friends must cause exactly one simulated remote prepay",
  );
  assert.equal(
    await prisma.payment.count({ where: { orderId: first.id } }),
    1,
    "Exactly one durable Payment must exist",
  );
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { orderId: first.id },
  });
  const winnerName =
    competitors[results.findIndex((result) => result.status === "fulfilled")];
  assert.equal(
    payment.payerUserId,
    ids[winnerName],
    "Durable payer must match the winning real User",
  );
  assert.equal(
    payment.payerOpenIdHash,
    crypto.hashIdentity(appId, openIds[ids[winnerName]]),
    "Durable payer hash must match the winner",
  );
  assert.equal(payment.kind, "FRIEND");
  assert.equal(payment.prepayState, "READY");
  await assertStatusRejected(
    () => friends.readIntent(principal("stranger"), share.token),
    403,
    "Third party cannot read payment parameters",
  );
  await assertStatusRejected(
    () => friends.reconcile(principal("stranger"), share.token),
    403,
    "Third party cannot query friend payment",
  );
  assert.equal(
    queryRequests.length,
    0,
    "Forbidden requests must not contact a payment query client",
  );
  await assertStatusRejected(
    () => friends.createIntent(principal("owner"), share.token),
    403,
    "Owner cannot masquerade as friend payer",
  );
  const beforeWrongPayer = await snapshot(first.id);
  const incorrect = signedNotification(
    transaction(payment, ids.stranger, "wrong-payer"),
    `${runId}-wrong-payer-event`,
  );
  await assertStatusRejected(
    () => wechat.notify(incorrect.body, incorrect.headers),
    409,
    "A valid signed callback for another payer must fail",
  );
  assert.deepEqual(
    await snapshot(first.id),
    beforeWrongPayer,
    "Wrong-payer callback must roll back all database mutations",
  );
  const verified = signedNotification(
    transaction(payment, payment.payerUserId, "success"),
    `${runId}-success-event`,
  );
  const settlementResults = await Promise.all([
    wechat.notify(verified.body, verified.headers),
    wechat.notify(verified.body, verified.headers),
  ]);
  assert.equal(
    settlementResults.filter((result) => !result.duplicate).length,
    1,
    "Concurrent duplicate callbacks must settle once",
  );
  assert.equal(
    settlementResults.filter((result) => result.duplicate).length,
    1,
    "Second callback must report duplicate",
  );
  const settled = await snapshot(first.id);
  assert.equal(
    settled.order.status,
    "PAID",
    "Verified callback must pay the owner's order",
  );
  assert.equal(
    settled.order.reservation.status,
    "CONFIRMED",
    "Verified callback must confirm the original HOLD",
  );
  assert.equal(settled.order.payment.status, "SUCCEEDED");
  assert.equal(
    settled.events.filter((event) => event.type === "FRIEND_PAYMENT_SUCCEEDED")
      .length,
    1,
    "Exactly one owner success notice must persist",
  );
  assert.equal(
    settled.outbox.filter((event) => event.type === "PAYMENT_SUCCEEDED").length,
    1,
    "Exactly one settlement outbox event must persist",
  );
  const notices = await friends.notifications(principal("owner"));
  assert.equal(
    notices.filter((notice) => notice.orderId === first.id).length,
    1,
  );
  assert.deepEqual(
    await friends.notifications(principal(winnerName)),
    [],
    "Payer must not inherit the owner's notification inbox",
  );
  assert.equal(
    JSON.stringify(notices).includes(payment.payerUserId),
    false,
    "Customer notification must not disclose payer ID",
  );
  await assertStatusRejected(
    () => friends.createIntent(principal(winnerName), share.token),
    409,
    "Paid orders cannot be paid again",
  );
  await assertStatusRejected(
    () =>
      refunds.requestOwn(
        principal(winnerName),
        first.id,
        `${runId}-friend-refund`,
      ),
    403,
    "Friend payer cannot request owner refund",
  );
  const refund = await refunds.requestOwn(
    principal("owner"),
    first.id,
    `${runId}-owner-refund`,
  );
  assert.equal(
    refund.status,
    "REQUESTED",
    "Owner retains existing refund application rights",
  );
  assert.equal(
    refund.amountFen,
    49800,
    "Owner refund uses authoritative server amount",
  );
  const second = await createOrder("late", 14400000);
  const lateShare = await friends.createShare(principal("owner"), second.id);
  await friends.createIntent(principal("friendA"), lateShare.token);
  const latePayment = await prisma.payment.findUniqueOrThrow({
    where: { orderId: second.id },
  });
  await assertStatusRejected(
    () => orders.cancelOwn(principal("owner"), second.id),
    409,
    "Unclosed real prepay cannot release a reservation",
  );
  // Model a verified channel-close result solely in this disposable fixture; no live close API runs.
  await prisma.payment.update({
    where: { id: latePayment.id },
    data: {
      status: "CLOSED",
      closeState: "CONFIRMED",
      closeRequestedAt: new Date(),
      closeDispatchedAt: new Date(),
      closeVerifiedAt: new Date(),
      closeReason: "CUSTOMER",
      closedAt: new Date(),
      providerTradeState: "CLOSED",
    },
  });
  await orders.cancelOwn(principal("owner"), second.id);
  const cancelled = await snapshot(second.id);
  assert.equal(cancelled.order.status, "CANCELLED");
  assert.equal(cancelled.order.reservation.status, "RELEASED");
  await assertStatusRejected(
    () => friends.createIntent(principal("friendA"), lateShare.token),
    409,
    "Cancelled orders cannot be prepaid again",
  );
  // Exercise the customer history-removal path before the signed late receipt arrives.
  // Hiding an order must never hide a later real-money exception from its owner.
  const hidden = await orders.hideOwn(principal("owner"), second.id);
  const hiddenOrder = await prisma.order.findUniqueOrThrow({
    where: { id: second.id },
  });
  assert.equal(
    hiddenOrder.customerHiddenAt?.toISOString(),
    hidden.hiddenAt,
    "The cancelled fixture order must be hidden before the late callback",
  );
  assert.equal(
    (await orders.listOwn(principal("owner"))).some(
      (order) => order.id === second.id,
    ),
    false,
    "The hidden cancelled order must no longer appear in customer history",
  );
  const lateCallback = signedNotification(
    transaction(latePayment, ids.friendA, "late"),
    `${runId}-late-event`,
  );
  await wechat.notify(lateCallback.body, lateCallback.headers);
  assert.deepEqual(
    await wechat.notify(lateCallback.body, lateCallback.headers),
    { duplicate: true },
  );
  const lateSettled = await snapshot(second.id);
  assert.equal(
    lateSettled.order.status,
    "CANCELLED",
    "Late callback must not reactivate a cancelled order",
  );
  assert.equal(
    lateSettled.order.reservation.status,
    "RELEASED",
    "Late callback must not revive the reservation",
  );
  assert.equal(
    lateSettled.order.customerHiddenAt?.toISOString(),
    hidden.hiddenAt,
    "Late settlement must preserve the customer's hidden history state",
  );
  assert.equal(
    lateSettled.order.payment.status,
    "SUCCEEDED",
    "Verified late funds must still be accounted for",
  );
  assert.equal(
    lateSettled.order.payment.failureCode,
    "FULFILLMENT_REVIEW_REQUIRED",
  );
  assert.equal(
    lateSettled.events.filter(
      (event) => event.type === "FRIEND_PAYMENT_FULFILLMENT_REVIEW_REQUIRED",
    ).length,
    1,
    "Late payment review notice must persist once",
  );
  assert.equal(
    lateSettled.outbox.filter(
      (event) => event.type === "PAYMENT_FULFILLMENT_REVIEW_REQUIRED",
    ).length,
    1,
  );
  const hiddenReviewNotices = (
    await friends.notifications(principal("owner"))
  ).filter((notice) => notice.orderId === second.id);
  assert.equal(
    hiddenReviewNotices.length,
    1,
    "Owner must still receive exactly one late-money review notice for a hidden order",
  );
  assert.equal(hiddenReviewNotices[0].title, "好友代付已到账，服务需核实");
  assert.deepEqual(
    await friends.notifications(principal("stranger")),
    [],
    "Another customer must not read a hidden order's review notice",
  );
  assert.deepEqual(
    await friends.notifications(principal("friendA")),
    [],
    "The friend payer must not inherit the owner's hidden-order review notice",
  );
  assert.equal(
    prepayRequests.length,
    2,
    "Both fixture orders must each issue exactly one simulated prepay",
  );
  console.log(
    "FRIEND_PAY_POSTGRES_OK: real PostgreSQL race, payer binding, signed callback rollback/idempotency, durable owner notices, owner-only refund and hidden-cancelled late-money notice isolation passed; no live WeChat I/O.",
  );
} catch (error) {
  console.error(
    "FRIEND_PAY_POSTGRES_FAILED:",
    error?.name ?? "Error",
    error?.code ?? "",
    error?.name === "AssertionError"
      ? error.message
      : "Isolated fixture verification failed; no live WeChat I/O.",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  // Intentionally no delete/truncate/drop. The caller discards only its isolated container.
}

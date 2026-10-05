import "reflect-metadata";
import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service.js";
import { PaymentsService } from "../src/payments/payments.service.js";
import { WechatPaymentsService } from "../src/payments/wechat-payments.service.js";
import {
  decodeWechatNotification,
  decodeWechatRefundNotification,
  type WechatTransaction,
  type WechatRefundResult,
} from "../src/payments/wechat-pay.protocol.js";
import { OrderStateMachine } from "../src/orders/order-state-machine.js";
import { OrdersService } from "../src/orders/orders.service.js";
import { RefundsService } from "../src/payments/refunds.service.js";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { RefundReconciliationWorker } from "../src/payments/refund-reconciliation.worker.js";
import { WechatPrepayService } from "../src/payments/wechat-prepay.service.js";
import { PaymentGatewayService } from "../src/payments/payment-gateway.service.js";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { WechatRecoveryService } from "../src/payments/wechat-recovery.service.js";
import { WechatRecoveryWorker } from "../src/payments/wechat-recovery.worker.js";

const databaseUrl = process.env.PAYMENT_DB_TEST_URL;
if (!databaseUrl)
  throw new Error("Provide PAYMENT_DB_TEST_URL for an isolated local database");
const target = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !(
    ["/zhongyuan_daojia", "/zhongyuan_daojia_test"].includes(target.pathname) ||
    (process.env.CONFIRM_PRIVATE_ACCEPTANCE_TEST === "true" &&
      target.pathname === "/zydj_acceptance_smoke" &&
      target.username === "zydj_acceptance")
  )
)
  throw new Error(
    "This verifier only accepts the dedicated local development/test databases",
  );
const prisma = new PrismaService({ datasourceUrl: databaseUrl });
const prefix = `payment-verification-${randomUUID()}`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const protocolConfig = {
  publicKeyId: "PUB_KEY_ID_LOCAL_TEST",
  publicKeyPem: keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  apiV3Key: "0".repeat(32),
  appId: "verification-app",
  merchantId: "1234567890",
};
const client = {
  verifierConfig: () => protocolConfig,
  decodeNotification: (body: Buffer, headers: Record<string, string>) =>
    decodeWechatNotification(body, headers, protocolConfig),
  decodeRefundNotification: (body: Buffer, headers: Record<string, string>) =>
    decodeWechatRefundNotification(body, headers, protocolConfig),
  assertRefundEnabled: () => {},
  buildRefundRequest: (input: unknown) => input,
  submitRefund: async (_input: unknown): Promise<WechatRefundResult> => {
    throw new Error("simulated network uncertainty");
  },
  queryRefund: async (_id: string): Promise<WechatRefundResult> => {
    throw new Error("unset fixture");
  },
};
const payments = new WechatPaymentsService(prisma, client as never);
const stateMachine = new OrderStateMachine();
const mock = new PaymentsService(
  prisma,
  new ConfigService({ NODE_ENV: "test" }) as never,
  stateMachine,
  { configuredProvider: () => PaymentProvider.MOCK } as never,
);
const orders = new OrdersService(prisma, {} as never, stateMachine, {
  assertOrderVerification: async () => undefined,
} as never);
let organizationId: string | undefined;
const orderIds: string[] = [];
let verificationSucceeded = false;

function notification(
  transaction:
    | WechatTransaction
    | (WechatRefundResult & { refund_status: string }),
  eventId: string,
  originalType = "transaction",
  eventType = "TRANSACTION.SUCCESS",
) {
  const nonce = "123456789012",
    aad = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(protocolConfig.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = Buffer.from(
    JSON.stringify(
      {
        id: eventId,
        event_type: eventType,
        resource_type: "encrypt-resource",
        resource: {
          original_type: originalType,
          algorithm: "AEAD_AES_256_GCM",
          nonce,
          associated_data: aad,
          ciphertext,
        },
      },
      null,
      2,
    ),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    "RSA-SHA256",
    Buffer.concat([
      Buffer.from(`${timestamp}\nverify-nonce\n`),
      body,
      Buffer.from("\n"),
    ]),
    keys.privateKey,
  ).toString("base64");
  return {
    body,
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": "verify-nonce",
      "wechatpay-serial": protocolConfig.publicKeyId,
      "wechatpay-signature": signature,
    },
  };
}

try {
  const organization = await prisma.organization.create({
    data: { name: prefix },
  });
  organizationId = organization.id;
  const therapist = await prisma.user.create({
    data: {
      organizationId,
      role: "THERAPIST",
      displayName: "本地支付验证技师",
    },
  });
  const service = await prisma.service.create({
    data: {
      organizationId,
      slug: prefix,
      name: "本地验证服务",
      category: "SPA_RELAXATION",
      subtitle: "测试",
      description: "自动化验证",
      durationMinutes: 60,
      priceFen: 19800n,
      steps: [],
      boundaries: [],
    },
  });
  let index = 0;
  async function fixture(
    expired = false,
    provider: PaymentProvider = PaymentProvider.WECHAT,
  ) {
    index++;
    const customer = await prisma.user.create({
      data: {
        organizationId: organization.id,
        role: "CUSTOMER",
        displayName: `本地支付验证客户${index}`,
      },
    });
    const principal = {
      userId: customer.id,
      sessionId: prefix,
      displayName: "验证",
      memberships: [],
    };
    const createdAt = new Date(Date.now() - 3600_000);
    const expiresAt = new Date(Date.now() + (expired ? -60_000 : 900_000));
    const startsAt = new Date(Date.now() + 7 * 86400_000 + index * 7200_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const reservation = await prisma.appointmentReservation.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        therapistId: therapist.id,
        serviceId: service.id,
        serviceAmountFen: 19800n,
        startsAt,
        endsAt,
        expiresAt,
        createdAt,
      },
    });
    const order = await prisma.order.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        therapistId: therapist.id,
        reservationId: reservation.id,
        status: "PENDING_PAYMENT",
        orderNo: `${prefix}-${index}`,
        appointmentStart: startsAt,
        appointmentEnd: endsAt,
        serviceAmountFen: 19800n,
        travelFeeFen: 0n,
        payableFen: 19800n,
        addressEncrypted: "local-test-no-personal-address",
        policyVersion: "local-verification",
        idempotencyKey: `${prefix}-${index}`,
        requestFingerprint: `${prefix}-${index}`,
        paymentExpiresAt: expiresAt,
        createdAt,
        items: {
          create: {
            serviceId: service.id,
            serviceName: service.name,
            durationMinutes: 60,
            unitPriceFen: 19800n,
          },
        },
      },
    });
    orderIds.push(order.id);
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider,
        merchantPaymentNo: `PAY${randomUUID().replaceAll("-", "").slice(0, 25)}`,
        amountFen: 19800n,
      },
    });
    const transaction: WechatTransaction = {
      appid: protocolConfig.appId,
      mchid: protocolConfig.merchantId,
      out_trade_no: payment.merchantPaymentNo,
      transaction_id: `TXN${randomUUID().replaceAll("-", "").slice(0, 25)}`,
      trade_type: "JSAPI",
      trade_state: "SUCCESS",
      success_time: new Date().toISOString(),
      amount: { total: 19800, currency: "CNY" },
    };
    return { order, payment, reservation, transaction, principal };
  }

  const prepayConfig = new ConfigService({
    NODE_ENV: "test",
    PAYMENT_PROVIDER: "wechat",
    AUTH_PROVIDER: "wechat",
    BRAND_NAME: "中原到家",
    WECHAT_MINIAPP_APP_ID: protocolConfig.appId,
    WECHAT_MCH_ID: protocolConfig.merchantId,
    WECHAT_PAY_NOTIFY_URL:
      "https://localhost.invalid/v1/payments/wechat/notify",
    AUTH_SESSION_PEPPER: `local-verification-${randomUUID()}`,
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
  }) as never;
  const prepayCrypto = new AuthCryptoService(prepayConfig);
  let prepayPosts = 0;
  let failPrepay = false;
  const prepayClient = {
    assertPrepayEnabled: () => {},
    prepay: async (request: any) => {
      prepayPosts++;
      assert.equal(request.amount.total, 19800);
      assert.equal(request.amount.currency, "CNY");
      assert.equal(request.appid, protocolConfig.appId);
      assert.equal(request.mchid, protocolConfig.merchantId);
      assert.ok(request.time_expire.endsWith("+00:00"));
      if (failPrepay) throw new Error("simulated prepay timeout");
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "wx-local-prepay";
    },
    paymentParameters: () => ({
      timeStamp: "123",
      nonceStr: "local",
      package: "prepay_id=wx-local-prepay",
      signType: "RSA",
      paySign: "local-only-placeholder",
    }),
  };
  const prepay = new WechatPrepayService(
    prisma,
    prepayConfig,
    prepayCrypto,
    new PaymentGatewayService(prepayConfig),
    prepayClient as never,
  );
  async function prepayFixture() {
    const result = await fixture();
    // Only this verifier's newly-created, event-free fixture is removed, never an existing merchant payment.
    await prisma.payment.delete({ where: { id: result.payment.id } });
    const subject = `verification-openid-${randomUUID()}`;
    await prisma.externalIdentity.create({
      data: {
        userId: result.principal.userId,
        provider: "WECHAT_MINIAPP",
        subjectHash: prepayCrypto.hashIdentity(protocolConfig.appId, subject),
        subjectEncrypted: prepayCrypto.encrypt(subject),
      },
    });
    return result;
  }
  const preparedFixture = await prepayFixture();
  const prepayResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      prepay.createIntent(preparedFixture.principal, preparedFixture.order.id),
    ),
  );
  assert.equal(prepayPosts, 1);
  assert.equal(new Set(prepayResults.map((intent) => intent.id)).size, 1);
  const readyIntent = await prepay.createIntent(
    preparedFixture.principal,
    preparedFixture.order.id,
  );
  assert.equal(readyIntent.prepayState, "READY");
  assert.equal(readyIntent.wechatPayParameters?.signType, "RSA");
  assert.equal(prepayPosts, 1);
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: preparedFixture.order.id },
      })
    ).status,
    "PENDING_PAYMENT",
  );
  await assert.rejects(
    orders.cancelOwn(preparedFixture.principal, preparedFixture.order.id),
    /原单尚未确认关闭/,
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: preparedFixture.reservation.id },
      })
    ).status,
    "HOLD",
  );
  await payments.applyTransaction(
    {
      ...preparedFixture.transaction,
      out_trade_no: (
        await prisma.payment.findUniqueOrThrow({
          where: { id: readyIntent.id },
        })
      ).merchantPaymentNo,
    },
    `${prefix}-prepay-paid`,
    "QUERY",
  );
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: preparedFixture.order.id },
      })
    ).status,
    "PAID",
  );
  await assert.rejects(
    prepay.createIntent(preparedFixture.principal, preparedFixture.order.id),
  );
  assert.equal(prepayPosts, 1);

  const unknownFixture = await prepayFixture();
  failPrepay = true;
  await assert.rejects(
    prepay.createIntent(unknownFixture.principal, unknownFixture.order.id),
    /结果未确认/,
  );
  const unknownIntent = await prepay.createIntent(
    unknownFixture.principal,
    unknownFixture.order.id,
  );
  assert.equal(unknownIntent.prepayState, "UNKNOWN");
  assert.equal(unknownIntent.wechatPayParameters, undefined);
  assert.equal(prepayPosts, 2);
  await assert.rejects(
    prisma.payment.update({
      where: { id: unknownIntent.id },
      data: { prepayState: "READY" },
    }),
  );
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: unknownIntent.id },
      })
    ).prepayState,
    "UNKNOWN",
  );

  const first = await fixture();
  const signed = notification(first.transaction, `${prefix}-concurrent`);
  const results = await Promise.all([
    payments.notify(signed.body, signed.headers),
    payments.notify(signed.body, signed.headers),
  ]);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: first.payment.id },
      })
    ).status,
    PaymentStatus.SUCCEEDED,
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } }))
      .status,
    "PAID",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: first.reservation.id },
      })
    ).status,
    ReservationStatus.CONFIRMED,
  );
  assert.equal(
    await prisma.paymentEvent.count({ where: { paymentId: first.payment.id } }),
    1,
  );
  assert.equal(
    await prisma.outboxEvent.count({ where: { aggregateId: first.order.id } }),
    1,
  );

  const mismatch = await fixture();
  const wrong = notification(
    { ...mismatch.transaction, amount: { total: 1, currency: "CNY" } },
    `${prefix}-mismatch`,
  );
  await assert.rejects(payments.notify(wrong.body, wrong.headers));
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: mismatch.payment.id },
      })
    ).status,
    PaymentStatus.PENDING,
  );
  assert.equal(
    await prisma.paymentEvent.count({
      where: { paymentId: mismatch.payment.id },
    }),
    0,
  );

  const late = await fixture(true);
  const lateSigned = notification(late.transaction, `${prefix}-late`);
  await payments.notify(lateSigned.body, lateSigned.headers);
  const latePayment = await prisma.payment.findUniqueOrThrow({
    where: { id: late.payment.id },
  });
  assert.equal(latePayment.status, PaymentStatus.SUCCEEDED);
  assert.equal(latePayment.failureCode, "FULFILLMENT_REVIEW_REQUIRED");
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: late.order.id } }))
      .status,
    "CANCELLED",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: late.reservation.id },
      })
    ).status,
    "EXPIRED",
  );

  const race = await fixture();
  const raceSigned = notification(race.transaction, `${prefix}-cancel-race`);
  const raceResult = await Promise.allSettled([
    orders.cancelOwn(race.principal, race.order.id),
    payments.notify(raceSigned.body, raceSigned.headers),
  ]);
  assert.equal(raceResult[1]?.status, "fulfilled");
  const racePayment = await prisma.payment.findUniqueOrThrow({
    where: { id: race.payment.id },
  });
  const raceOrder = await prisma.order.findUniqueOrThrow({
    where: { id: race.order.id },
  });
  const raceReservation = await prisma.appointmentReservation.findUniqueOrThrow(
    { where: { id: race.reservation.id } },
  );
  assert.equal(racePayment.status, "SUCCEEDED");
  if (raceOrder.status === "PAID") {
    assert.equal(raceReservation.status, "CONFIRMED");
    assert.equal(racePayment.failureCode, null);
  } else {
    assert.equal(raceOrder.status, "CANCELLED");
    assert.equal(raceReservation.status, "RELEASED");
    assert.equal(racePayment.failureCode, "FULFILLMENT_REVIEW_REQUIRED");
  }

  const pendingReal = await fixture(true);
  assert.equal(
    await mock.expirePendingOrders(new Date(), pendingReal.order.id),
    0,
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: pendingReal.reservation.id },
      })
    ).status,
    "HOLD",
  );
  const mockRace = await fixture(false, PaymentProvider.MOCK);
  const future = new Date(Date.now() + 3600_000);
  await Promise.allSettled([
    mock.confirmMock(mockRace.principal, mockRace.payment.id),
    mock.expirePendingOrders(future, mockRace.order.id),
  ]);
  const mockOrder = await prisma.order.findUniqueOrThrow({
    where: { id: mockRace.order.id },
  });
  const mockPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: mockRace.payment.id },
  });
  assert.ok(
    (mockOrder.status === "PAID" && mockPayment.status === "SUCCEEDED") ||
      (mockOrder.status === "CANCELLED" && mockPayment.status === "CLOSED"),
  );

  const mockDuplicate = await fixture(false, PaymentProvider.MOCK);
  const duplicateResults = await Promise.all([
    mock.confirmMock(mockDuplicate.principal, mockDuplicate.payment.id),
    mock.confirmMock(mockDuplicate.principal, mockDuplicate.payment.id),
  ]);
  assert.ok(duplicateResults.every((result) => result.status === "SUCCEEDED"));
  assert.equal(
    await prisma.paymentEvent.count({
      where: {
        paymentId: mockDuplicate.payment.id,
        type: "MOCK_PAYMENT_SUCCEEDED",
      },
    }),
    1,
  );

  const recoveryConfig = new ConfigService({
    PAYMENT_PROVIDER: "wechat",
    WECHAT_PAY_RECOVERY_ENABLED: "true",
  }) as never;
  let closePosts = 0;
  const recoveryClient = {
    verifierConfig: () => protocolConfig,
    assertRecoveryEnabled: () => {},
    queryTransaction: async (_no: string): Promise<unknown> => {
      throw new Error("unset query fixture");
    },
    closeTransaction: async (_no: string) => {
      closePosts++;
    },
  };
  const recovery = new WechatRecoveryService(
    prisma,
    recoveryConfig,
    recoveryClient as never,
    payments,
    orders,
  );
  const recoveryTwo = new WechatRecoveryService(
    prisma,
    recoveryConfig,
    recoveryClient as never,
    payments,
    orders,
  );
  const original = await fixture(true);
  const unpaid = {
    appid: protocolConfig.appId,
    mchid: protocolConfig.merchantId,
    out_trade_no: original.payment.merchantPaymentNo,
    trade_state: "NOTPAY",
  };
  let originalQueries = 0;
  recoveryClient.queryTransaction = async (no) => {
    assert.equal(no, original.payment.merchantPaymentNo);
    originalQueries++;
    return {
      ...unpaid,
      trade_state: originalQueries === 1 ? "NOTPAY" : "CLOSED",
    };
  };
  await Promise.all([
    recovery.recover(original.payment.id),
    recoveryTwo.recover(original.payment.id),
  ]);
  assert.equal(closePosts, 1);
  assert.equal(originalQueries, 2);
  const closedOriginal = await prisma.payment.findUniqueOrThrow({
    where: { id: original.payment.id },
  });
  assert.equal(closedOriginal.status, "CLOSED");
  assert.equal(closedOriginal.closeState, "CONFIRMED");
  assert.equal(closedOriginal.recoveryAttempts, 1);
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: original.reservation.id },
      })
    ).status,
    "EXPIRED",
  );
  assert.equal(
    await prisma.paymentEvent.count({
      where: { paymentId: original.payment.id, type: "WECHAT_CLOSE_CONFIRMED" },
    }),
    1,
  );
  await recovery.recover(original.payment.id);
  assert.equal(closePosts, 1);
  // Even a late signed success after closure is recorded; never restore a released reservation.
  const closedLate = notification(
    original.transaction,
    `${prefix}-closed-late`,
  );
  await payments.notify(closedLate.body, closedLate.headers);
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: original.payment.id },
      })
    ).failureCode,
    "FULFILLMENT_REVIEW_REQUIRED",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: original.reservation.id },
      })
    ).status,
    "EXPIRED",
  );

  const uncertainClose = await fixture(true);
  recoveryClient.queryTransaction = async (no) => ({
    ...unpaid,
    out_trade_no: no,
  });
  recoveryClient.closeTransaction = async (no) => {
    assert.equal(no, uncertainClose.payment.merchantPaymentNo);
    closePosts++;
    throw new Error("synthetic close timeout");
  };
  await recovery.recover(uncertainClose.payment.id);
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: uncertainClose.payment.id },
      })
    ).closeState,
    "UNKNOWN",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: uncertainClose.reservation.id },
      })
    ).status,
    "HOLD",
  );
  const postsBeforeRecheck = closePosts;
  await prisma.payment.update({
    where: { id: uncertainClose.payment.id },
    data: { recoveryNextCheckAt: new Date(0) },
  });
  recoveryClient.queryTransaction = async (no) => ({
    ...unpaid,
    out_trade_no: no,
    trade_state: "CLOSED",
  });
  await recovery.recover(uncertainClose.payment.id);
  assert.equal(closePosts, postsBeforeRecheck);
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: uncertainClose.payment.id },
      })
    ).status,
    "CLOSED",
  );

  const recoveryRace = await fixture();
  let raceQueries = 0;
  recoveryClient.queryTransaction = async (no) => {
    raceQueries++;
    return {
      ...unpaid,
      out_trade_no: no,
      trade_state: raceQueries === 1 ? "NOTPAY" : "CLOSED",
    };
  };
  recoveryClient.closeTransaction = async (no) => {
    assert.equal(no, recoveryRace.payment.merchantPaymentNo);
    closePosts++;
    const signed = notification(
      recoveryRace.transaction,
      `${prefix}-recovery-callback-race`,
    );
    await payments.notify(signed.body, signed.headers);
  };
  await recovery.closeOwnOrder(recoveryRace.principal, recoveryRace.order.id);
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: recoveryRace.payment.id },
      })
    ).status,
    "SUCCEEDED",
  );
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { id: recoveryRace.order.id },
      })
    ).status,
    "PAID",
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: recoveryRace.reservation.id },
      })
    ).status,
    "CONFIRMED",
  );

  const exhausted = await fixture(true);
  await prisma.payment.update({
    where: { id: exhausted.payment.id },
    data: {
      recoveryAttempts: 12,
      recoveryLeaseToken: "synthetic-crashed-lease",
      recoveryLeaseUntil: new Date(0),
      recoveryNextCheckAt: null,
    },
  });
  const exhaustedPosts = closePosts;
  const recoveryWorker = new WechatRecoveryWorker(prisma, recovery);
  // Restrict worker scan to this run's originals, leaving all unrelated DB records untouched.
  const workerPrisma = {
    payment: { findMany: async () => [exhausted.payment] },
  };
  const isolatedWorker = new WechatRecoveryWorker(
    workerPrisma as never,
    recovery,
  );
  await isolatedWorker.run();
  await isolatedWorker.run();
  assert.equal(closePosts, exhaustedPosts);
  assert.ok(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: exhausted.payment.id },
      })
    ).recoveryReviewAt,
  );
  assert.equal(
    await prisma.outboxEvent.count({
      where: {
        aggregateId: exhausted.order.id,
        type: "WECHAT_RECOVERY_REVIEW_REQUIRED",
      },
    }),
    1,
  );
  assert.equal(
    (
      await prisma.appointmentReservation.findUniqueOrThrow({
        where: { id: exhausted.reservation.id },
      })
    ).status,
    "HOLD",
  );
  await assert.rejects(
    prisma.payment.update({
      where: { id: exhausted.payment.id },
      data: { recoveryAttempts: 13 },
    }),
  );
  await assert.rejects(
    prisma.payment.update({
      where: { id: exhausted.payment.id },
      data: { recoveryLeaseToken: "invalid-pair" },
    }),
  );
  recoveryWorker.onModuleDestroy();

  const refunds = new RefundsService(
    prisma,
    new AccessControlService(),
    new ConfigService({
      NODE_ENV: "test",
      PAYMENT_PROVIDER: "wechat",
    }) as never,
    client as never,
    stateMachine,
  );
  const applicant = {
    ...first.principal,
    userId: "synthetic-finance-a",
    memberships: [{ organizationId, role: "ADMIN" as const }],
  };
  const reviewer = { ...applicant, userId: "synthetic-finance-b" };
  const refundRequests = await Promise.all([
    refunds.request(
      applicant,
      organizationId,
      first.payment.id,
      { reason: "CUSTOMER_CANCELLED" },
      `${prefix}-refund`,
    ),
    refunds.request(
      applicant,
      organizationId,
      first.payment.id,
      { reason: "CUSTOMER_CANCELLED" },
      `${prefix}-refund`,
    ),
  ]);
  const refund = refundRequests[0]!;
  assert.equal(refund.id, refundRequests[1]!.id);
  await assert.rejects(
    refunds.review(applicant, organizationId, refund.id, true, {
      code: "CONFIRMED",
    }),
  );
  await refunds.review(reviewer, organizationId, refund.id, true, {
    code: "CONFIRMED",
  });
  let posts = 0;
  client.submitRefund = async () => {
    posts++;
    throw new Error("simulated network uncertainty");
  };
  await assert.rejects(refunds.submit(reviewer, organizationId, refund.id));
  assert.equal(
    (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }))
      .status,
    "UNKNOWN",
  );
  await refunds.submit(reviewer, organizationId, refund.id);
  assert.equal(posts, 1);
  const persisted = await prisma.refund.findUniqueOrThrow({
    where: { id: refund.id },
  });
  const refundResult: WechatRefundResult = {
    mchid: protocolConfig.merchantId,
    out_trade_no: first.payment.merchantPaymentNo,
    transaction_id: first.transaction.transaction_id!,
    out_refund_no: persisted.merchantRefundNo,
    refund_id: `WXRF${randomUUID()}`,
    status: "SUCCESS",
    success_time: new Date().toISOString(),
    amount: { total: 19800, refund: 19800, currency: "CNY" },
  };
  let queries = 0;
  client.queryRefund = async (no) => {
    assert.equal(no, persisted.merchantRefundNo);
    queries++;
    return { ...refundResult, status: "PROCESSING", success_time: undefined };
  };
  await prisma.refund.update({
    where: { id: refund.id },
    data: { nextCheckAt: new Date(0) },
  });
  const workers = [
    new RefundReconciliationWorker(
      prisma,
      refunds,
      new ConfigService({ PAYMENT_PROVIDER: "wechat" }) as never,
    ),
    new RefundReconciliationWorker(
      prisma,
      refunds,
      new ConfigService({ PAYMENT_PROVIDER: "wechat" }) as never,
    ),
  ];
  await Promise.all(workers.map((worker) => worker.run()));
  assert.equal(queries, 1);
  const refundSigned = notification(
    { ...refundResult, refund_status: "SUCCESS" },
    `${prefix}-refund-success`,
    "refund",
    "REFUND.SUCCESS",
  );
  const refundResults = await Promise.all([
    refunds.notify(refundSigned.body, refundSigned.headers),
    refunds.notify(refundSigned.body, refundSigned.headers),
  ]);
  assert.equal(refundResults.filter((row) => row.duplicate).length, 1);
  assert.equal(
    await prisma.refundLedgerPosting.count({ where: { refundId: refund.id } }),
    1,
  );
  assert.equal(
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id: first.payment.id },
      })
    ).refundedFen,
    19800n,
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } }))
      .status,
    "REFUNDED",
  );
  const staleClosed = notification(
    {
      ...refundResult,
      status: "CLOSED",
      refund_status: "CLOSED",
      success_time: undefined,
    },
    `${prefix}-refund-stale`,
    "refund",
    "REFUND.CLOSED",
  );
  await refunds.notify(staleClosed.body, staleClosed.headers);
  assert.equal(
    (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }))
      .status,
    "SUCCEEDED",
  );

  verificationSucceeded = true;
  console.log(
    JSON.stringify({
      verified: true,
      concurrentNotificationExactlyOnce: true,
      concurrentPrepaySingleDispatch: true,
      originalQueryCloseRecheckConfirmed: true,
      multiInstancePaymentRecoveryLease: true,
      closeTimeoutRetainsHoldAndUsesOriginal: true,
      successNotificationWinsCloseRace: true,
      latePaymentAfterCloseRequiresReview: true,
      crashedFinalLeaseEscalatesOnce: true,
      recoveryDatabaseGuards: true,
      prepayTimeoutNeverResubmitted: prepayPosts === 2,
      pendingWechatCancellationDoesNotRelease: true,
      prepayDatabaseGuards: true,
      mismatchedAmountRejected: true,
      latePaymentReviewRecorded: true,
      cancelPaymentRaceConsistent: true,
      realPaymentNotLocallyExpired: true,
      mockExpiryRaceConsistent: true,
      concurrentMockSuccessIdempotent: true,
      concurrentRefundExactlyOnce: true,
      uncertainPostNeverResubmitted: posts === 1,
      multiInstanceRefundQueryLease: queries === 1,
      signedRefundSuccessAndStaleClosedConsistent: true,
    }),
  );
} finally {
  if (organizationId) {
    const scope = { order: { organizationId } };
    await prisma.$transaction(async (tx) => {
      const refundScope = { refund: { payment: scope } };
      await tx.refundLedgerPosting.deleteMany({ where: refundScope });
      await tx.refundEvent.deleteMany({ where: refundScope });
      await tx.refund.deleteMany({ where: { payment: scope } });
      await tx.paymentEvent.deleteMany({ where: { payment: scope } });
      await tx.payment.deleteMany({ where: scope });
      await tx.orderEvent.deleteMany({ where: scope });
      await tx.orderItem.deleteMany({ where: scope });
      await tx.outboxEvent.deleteMany({
        where: { aggregateId: { in: orderIds } },
      });
      await tx.auditLog.deleteMany({ where: { organizationId } });
      await tx.order.deleteMany({ where: { organizationId } });
      await tx.appointmentReservation.deleteMany({ where: { organizationId } });
      await tx.service.deleteMany({ where: { organizationId } });
      await tx.user.deleteMany({ where: { organizationId } });
      await tx.organization.delete({ where: { id: organizationId } });
    });
    console.log(
      JSON.stringify({ syntheticFixturesRemoved: true, verificationSucceeded }),
    );
  }
  await prisma.$disconnect();
}

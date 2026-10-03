import "reflect-metadata";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PaymentProvider, PaymentStatus, ReservationStatus } from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service.js";
import { PaymentsService } from "../src/payments/payments.service.js";
import { WechatPaymentsService } from "../src/payments/wechat-payments.service.js";
import { decodeWechatNotification, type WechatTransaction } from "../src/payments/wechat-pay.protocol.js";
import { OrderStateMachine } from "../src/orders/order-state-machine.js";
import { OrdersService } from "../src/orders/orders.service.js";

const databaseUrl = process.env.PAYMENT_DB_TEST_URL;
if (!databaseUrl) throw new Error("Provide PAYMENT_DB_TEST_URL for an isolated local database");
const target = new URL(databaseUrl);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/zhongyuan_daojia") throw new Error("This verifier only accepts the local zhongyuan_daojia development database");
const prisma = new PrismaService({ datasourceUrl: databaseUrl });
const prefix = `payment-verification-${randomUUID()}`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const protocolConfig = { publicKeyId: "PUB_KEY_ID_LOCAL_TEST", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), apiV3Key: "0".repeat(32), appId: "verification-app", merchantId: "1234567890" };
const client = { verifierConfig: () => protocolConfig, decodeNotification: (body: Buffer, headers: Record<string, string>) => decodeWechatNotification(body, headers, protocolConfig) };
const payments = new WechatPaymentsService(prisma, client as never);
const stateMachine = new OrderStateMachine();
const mock = new PaymentsService(prisma, new ConfigService({ NODE_ENV: "test" }) as never, stateMachine, { configuredProvider: () => PaymentProvider.MOCK } as never);
const orders = new OrdersService(prisma, {} as never, stateMachine);
let organizationId: string | undefined;
const orderIds: string[] = [];
let verificationSucceeded = false;

function notification(transaction: WechatTransaction, eventId: string) {
  const nonce = "123456789012", aad = "transaction";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(protocolConfig.apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const body = Buffer.from(JSON.stringify({ id: eventId, event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: { original_type: "transaction", algorithm: "AEAD_AES_256_GCM", nonce, associated_data: aad, ciphertext } }, null, 2));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nverify-nonce\n`), body, Buffer.from("\n")]), keys.privateKey).toString("base64");
  return { body, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": "verify-nonce", "wechatpay-serial": protocolConfig.publicKeyId, "wechatpay-signature": signature } };
}

try {
  const organization = await prisma.organization.create({ data: { name: prefix } });
  organizationId = organization.id;
  const therapist = await prisma.user.create({ data: { organizationId, role: "THERAPIST", displayName: "本地支付验证技师" } });
  const service = await prisma.service.create({ data: { organizationId, slug: prefix, name: "本地验证服务", category: "SPA_RELAXATION", subtitle: "测试", description: "自动化验证", durationMinutes: 60, priceFen: 19800n, steps: [], boundaries: [] } });
  let index = 0;
  async function fixture(expired = false, provider: PaymentProvider = PaymentProvider.WECHAT) {
    index++;
    const customer = await prisma.user.create({ data: { organizationId: organization.id, role: "CUSTOMER", displayName: `本地支付验证客户${index}` } });
    const principal = { userId: customer.id, sessionId: prefix, displayName: "验证", memberships: [] };
    const createdAt = new Date(Date.now() - 3600_000);
    const expiresAt = new Date(Date.now() + (expired ? -60_000 : 900_000));
    const startsAt = new Date(Date.now() + 7 * 86400_000 + index * 7200_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const reservation = await prisma.appointmentReservation.create({ data: { organizationId: organization.id, customerId: customer.id, therapistId: therapist.id, serviceId: service.id, serviceAmountFen: 19800n, startsAt, endsAt, expiresAt, createdAt } });
    const order = await prisma.order.create({ data: { organizationId: organization.id, customerId: customer.id, therapistId: therapist.id, reservationId: reservation.id, status: "PENDING_PAYMENT", orderNo: `${prefix}-${index}`, appointmentStart: startsAt, appointmentEnd: endsAt, serviceAmountFen: 19800n, travelFeeFen: 0n, payableFen: 19800n, addressEncrypted: "local-test-no-personal-address", policyVersion: "local-verification", idempotencyKey: `${prefix}-${index}`, requestFingerprint: `${prefix}-${index}`, paymentExpiresAt: expiresAt, createdAt, items: { create: { serviceId: service.id, serviceName: service.name, durationMinutes: 60, unitPriceFen: 19800n } } } });
    orderIds.push(order.id);
    const payment = await prisma.payment.create({ data: { orderId: order.id, provider, merchantPaymentNo: `PAY${randomUUID().replaceAll("-", "").slice(0, 25)}`, amountFen: 19800n } });
    const transaction: WechatTransaction = { appid: protocolConfig.appId, mchid: protocolConfig.merchantId, out_trade_no: payment.merchantPaymentNo, transaction_id: `TXN${randomUUID().replaceAll("-", "").slice(0, 25)}`, trade_type: "JSAPI", trade_state: "SUCCESS", success_time: new Date().toISOString(), amount: { total: 19800, currency: "CNY" } };
    return { order, payment, reservation, transaction, principal };
  }

  const first = await fixture();
  const signed = notification(first.transaction, `${prefix}-concurrent`);
  const results = await Promise.all([payments.notify(signed.body, signed.headers), payments.notify(signed.body, signed.headers)]);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: first.payment.id } })).status, PaymentStatus.SUCCEEDED);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status, "PAID");
  assert.equal((await prisma.appointmentReservation.findUniqueOrThrow({ where: { id: first.reservation.id } })).status, ReservationStatus.CONFIRMED);
  assert.equal(await prisma.paymentEvent.count({ where: { paymentId: first.payment.id } }), 1);
  assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: first.order.id } }), 1);

  const mismatch = await fixture();
  const wrong = notification({ ...mismatch.transaction, amount: { total: 1, currency: "CNY" } }, `${prefix}-mismatch`);
  await assert.rejects(payments.notify(wrong.body, wrong.headers));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: mismatch.payment.id } })).status, PaymentStatus.PENDING);
  assert.equal(await prisma.paymentEvent.count({ where: { paymentId: mismatch.payment.id } }), 0);

  const late = await fixture(true);
  const lateSigned = notification(late.transaction, `${prefix}-late`);
  await payments.notify(lateSigned.body, lateSigned.headers);
  const latePayment = await prisma.payment.findUniqueOrThrow({ where: { id: late.payment.id } });
  assert.equal(latePayment.status, PaymentStatus.SUCCEEDED);
  assert.equal(latePayment.failureCode, "FULFILLMENT_REVIEW_REQUIRED");
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: late.order.id } })).status, "CANCELLED");
  assert.equal((await prisma.appointmentReservation.findUniqueOrThrow({ where: { id: late.reservation.id } })).status, "EXPIRED");

  const race = await fixture();
  const raceSigned = notification(race.transaction, `${prefix}-cancel-race`);
  const raceResult = await Promise.allSettled([orders.cancelOwn(race.principal, race.order.id), payments.notify(raceSigned.body, raceSigned.headers)]);
  assert.equal(raceResult[1]?.status, "fulfilled");
  const racePayment = await prisma.payment.findUniqueOrThrow({ where: { id: race.payment.id } });
  const raceOrder = await prisma.order.findUniqueOrThrow({ where: { id: race.order.id } });
  const raceReservation = await prisma.appointmentReservation.findUniqueOrThrow({ where: { id: race.reservation.id } });
  assert.equal(racePayment.status, "SUCCEEDED");
  if (raceOrder.status === "PAID") { assert.equal(raceReservation.status, "CONFIRMED"); assert.equal(racePayment.failureCode, null); }
  else { assert.equal(raceOrder.status, "CANCELLED"); assert.equal(raceReservation.status, "RELEASED"); assert.equal(racePayment.failureCode, "FULFILLMENT_REVIEW_REQUIRED"); }

  const pendingReal = await fixture(true);
  assert.equal(await mock.expirePendingOrders(new Date(), pendingReal.order.id), 0);
  assert.equal((await prisma.appointmentReservation.findUniqueOrThrow({ where: { id: pendingReal.reservation.id } })).status, "HOLD");
  const mockRace = await fixture(false, PaymentProvider.MOCK);
  const future = new Date(Date.now() + 3600_000);
  await Promise.allSettled([mock.confirmMock(mockRace.principal, mockRace.payment.id), mock.expirePendingOrders(future, mockRace.order.id)]);
  const mockOrder = await prisma.order.findUniqueOrThrow({ where: { id: mockRace.order.id } });
  const mockPayment = await prisma.payment.findUniqueOrThrow({ where: { id: mockRace.payment.id } });
  assert.ok((mockOrder.status === "PAID" && mockPayment.status === "SUCCEEDED") || (mockOrder.status === "CANCELLED" && mockPayment.status === "CLOSED"));

  verificationSucceeded = true;
  console.log(JSON.stringify({ verified: true, concurrentNotificationExactlyOnce: true, mismatchedAmountRejected: true, latePaymentReviewRecorded: true, cancelPaymentRaceConsistent: true, realPaymentNotLocallyExpired: true, mockExpiryRaceConsistent: true }));
} finally {
  if (organizationId) {
    const scope = { order: { organizationId } };
    await prisma.$transaction(async (tx) => {
      await tx.paymentEvent.deleteMany({ where: { payment: scope } });
      await tx.payment.deleteMany({ where: scope });
      await tx.orderEvent.deleteMany({ where: scope });
      await tx.orderItem.deleteMany({ where: scope });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
      await tx.auditLog.deleteMany({ where: { organizationId } });
      await tx.order.deleteMany({ where: { organizationId } });
      await tx.appointmentReservation.deleteMany({ where: { organizationId } });
      await tx.service.deleteMany({ where: { organizationId } });
      await tx.user.deleteMany({ where: { organizationId } });
      await tx.organization.delete({ where: { id: organizationId } });
    });
    console.log(JSON.stringify({ syntheticFixturesRemoved: true, verificationSucceeded }));
  }
  await prisma.$disconnect();
}

import "reflect-metadata";
import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { ServiceCategory, UserRole } from "@prisma/client";
import type { AuthPrincipal } from "../src/auth/auth.types.js";
import { CustomerCouponsService } from "../src/customer-center/customer-coupons.service.js";
import { occupyOrderCoupon } from "../src/customer-center/order-coupons.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { OrderStateMachine } from "../src/orders/order-state-machine.js";
import { OrdersService } from "../src/orders/orders.service.js";
import { StoredValueRechargesService } from "../src/payments/stored-value-recharges.service.js";
import { WechatPaymentsService } from "../src/payments/wechat-payments.service.js";
import {
  decodeWechatNotification,
  type WechatTransaction,
} from "../src/payments/wechat-pay.protocol.js";

// This integration verifier has no production path and never contacts WeChat.
const databaseUrl = process.env.BENEFITS_DB_TEST_URL;
if (!databaseUrl)
  throw new Error(
    "Provide BENEFITS_DB_TEST_URL for the dedicated local test database",
  );
const target = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1"].includes(target.hostname) ||
  target.port !== "55439" ||
  target.pathname !== "/zydj_benefits_test" ||
  target.username !== "zydj_benefits_test"
)
  throw new Error("Only localhost:55439/zydj_benefits_test is allowed");

const prisma = new PrismaService({ datasourceUrl: databaseUrl });
const prefix = `benefits-test-${randomUUID()}`;
const proof: string[] = [];
function verified(label: string) {
  proof.push(label);
  process.stdout.write(`PASS ${label}\n`);
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const identity = {
  publicKeyId: "PUB_KEY_ID_LOCAL_BENEFITS_TEST",
  publicKeyPem: keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  apiV3Key: "0".repeat(32),
  appId: "local-benefits-test-app",
  merchantId: "1234567890",
};
let syntheticPrepayCalls = 0;
let queryCalls = 0;
const client = {
  verifierConfig: () => identity,
  assertPrepayEnabled: () => undefined,
  prepay: async () => {
    syntheticPrepayCalls++;
    return `test-prepay-${randomUUID()}`;
  },
  paymentParameters: (prepayId: string) => ({
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: "local-test-nonce",
    package: `prepay_id=${prepayId}`,
    signType: "RSA",
    paySign: "LOCAL_TEST_ONLY_NOT_VALID_FOR_WECHAT",
  }),
  queryTransaction: async () => {
    queryCalls++;
    throw new Error("No network calls allowed in this test");
  },
  decodeNotification: (body: Buffer, headers: Record<string, string>) =>
    decodeWechatNotification(body, headers, identity),
};

function signedNotification(transaction: WechatTransaction) {
  const nonce = "localtest123",
    aad = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(identity.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = Buffer.from(
    JSON.stringify({
      id: `test-event-${randomUUID()}`,
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: {
        original_type: "transaction",
        algorithm: "AEAD_AES_256_GCM",
        nonce,
        associated_data: aad,
        ciphertext,
      },
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000)),
    headerNonce = randomUUID();
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${headerNonce}\n${body.toString()}\n`),
    keys.privateKey,
  ).toString("base64");
  return {
    body,
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": headerNonce,
      "wechatpay-serial": identity.publicKeyId,
      "wechatpay-signature": signature,
    },
  };
}

try {
  const organization = await prisma.organization.create({
    data: { name: prefix },
  });
  const customer = await prisma.user.create({
    data: {
      organizationId: organization.id,
      role: UserRole.CUSTOMER,
      displayName: "本机权益验证客户",
      phoneEncrypted: "SYNTHETIC_TEST_ENCRYPTED_PHONE",
      phoneVerifiedAt: new Date(),
    },
  });
  const therapist = await prisma.user.create({
    data: {
      organizationId: organization.id,
      role: UserRole.THERAPIST,
      displayName: "本机权益验证技师",
    },
  });
  const catalog = await prisma.service.create({
    data: {
      organizationId: organization.id,
      slug: prefix,
      name: "本机权益验证服务",
      category: ServiceCategory.MASSAGE,
      subtitle: "测试资料",
      description: "不对外展示的本机合成资料",
      durationMinutes: 60,
      priceFen: 49_800n,
      published: true,
      steps: [],
      boundaries: [],
    },
  });
  const principal: AuthPrincipal = {
    userId: customer.id,
    sessionId: prefix,
    displayName: customer.displayName,
    memberships: [],
  };
  const coupons = new CustomerCouponsService(prisma);
  const before = await coupons.newcomerOffer(principal, organization.id);
  assert.equal(before.claimed, false);
  assert.equal(
    await prisma.customerCoupon.count({ where: { customerId: customer.id } }),
    0,
  );
  verified("GET eligibility creates zero coupon rows");

  const claims = await Promise.all(
    Array.from({ length: 8 }, () =>
      coupons.claimNewcomerCoupons(principal, organization.id),
    ),
  );
  assert.equal(claims.filter((result) => !result.idempotentReplay).length, 1);
  const claimed = await prisma.customerCoupon.findMany({
    where: { customerId: customer.id },
    orderBy: { amountFen: "desc" },
  });
  assert.equal(claimed.length, 4);
  assert.deepEqual(
    claimed.map((row) => [
      Number(row.amountFen),
      Number(row.minimumSpendFen),
      row.canApplyToTravelFee,
    ]),
    [
      [4000, 49800, false],
      [3000, 39800, false],
      [2000, 29800, false],
      [1000, 19800, false],
    ],
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        organizationId: organization.id,
        action: "NEWCOMER_COUPONS_CLAIMED",
      },
    }),
    1,
  );
  verified(
    "8 simultaneous manual claims produce exactly four requested coupons and one audit",
  );

  const reservations = [];
  for (let index = 0; index < 1; index++) {
    reservations.push(
      await prisma.appointmentReservation.create({
        data: {
          organizationId: organization.id,
          customerId: customer.id,
          therapistId: therapist.id,
          serviceId: catalog.id,
          serviceAmountFen: 49_800n,
          startsAt: new Date(Date.now() + (index + 1) * 3_600_000),
          endsAt: new Date(Date.now() + (index + 2) * 3_600_000),
          expiresAt: new Date(Date.now() + 600_000),
        },
      }),
    );
  }
  const orders = new OrdersService(
    prisma,
    { encrypt: (value: string) => `TEST_ONLY:${value}` } as never,
    new OrderStateMachine(),
    { assertOrderVerification: async () => undefined } as never,
  );
  const quote = await orders.quote(principal, reservations[0]!.id);
  assert.equal(quote.discountFen, 4000);
  assert.equal(quote.payableFen, 45800);
  assert.equal(quote.couponId, claimed[0]!.id);
  const createdOrder = await orders.create(
    principal,
    {
      reservationId: reservations[0]!.id,
      couponId: quote.couponId,
      address: {
        contactName: "合成测试联系人",
        phone: "13800000000",
        detail: "仅限本机测试地址",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      },
    },
    `${prefix}-order-0`,
  );
  const savedOrder = await prisma.order.findUniqueOrThrow({
    where: { id: createdOrder.data.id },
    include: { appliedCoupon: true },
  });
  assert.equal(savedOrder.discountFen, 4000n);
  assert.equal(savedOrder.payableFen, 45800n);
  assert.equal(savedOrder.appliedCoupon?.id, claimed[0]!.id);
  assert.equal(
    await prisma.order.count({ where: { customerId: customer.id } }),
    1,
  );
  verified(
    "server order uses the quoted coupon and persists a payable snapshot of 45800 fen",
  );
  await orders.cancelOwn(principal, savedOrder.id);
  const restored = await prisma.customerCoupon.findUniqueOrThrow({
    where: { id: claimed[0]!.id },
  });
  assert.equal(restored.status, "AVAILABLE");
  assert.equal(restored.usedOrderId, null);
  verified("unpaid cancellation restores the coupon within the transaction");

  // Production correctly permits only one HOLD per customer. Exercise the
  // coupon CAS with independent synthetic orders instead of relaxing that constraint.
  const competingOrders = await Promise.allSettled(
    [0, 1].map((index) =>
      prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            organizationId: organization.id,
            customerId: customer.id,
            therapistId: therapist.id,
            orderNo: `${prefix}-cas-${index}`,
            status: "PENDING_PAYMENT",
            appointmentStart: new Date(Date.now() + (index + 3) * 3_600_000),
            appointmentEnd: new Date(Date.now() + (index + 4) * 3_600_000),
            serviceAmountFen: 49800n,
            travelFeeFen: 0n,
            discountFen: 4000n,
            payableFen: 45800n,
            addressEncrypted: "SYNTHETIC_TEST_ADDRESS",
            policyVersion: "LOCAL_CAS_TEST_ONLY",
            idempotencyKey: `${prefix}-cas-${index}`,
            requestFingerprint: prefix,
          },
        });
        await occupyOrderCoupon(tx, claimed[0]!.id, order.id, new Date());
        return order;
      }),
    ),
  );
  assert.equal(
    competingOrders.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    competingOrders.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    await prisma.order.count({ where: { customerId: customer.id } }),
    2,
  );
  verified(
    "two database transactions compete for one coupon; CAS permits one and rolls back the other order",
  );

  const storedValue = new StoredValueRechargesService(
    prisma,
    new ConfigService({
      STORED_VALUE_RECHARGE_ENABLED: "true",
      BRAND_NAME: "本机验证",
    }) as never,
    { buildWechatJsapiRequest: (request: unknown) => request } as never,
    client as never,
    { payerOpenId: async () => "LOCAL_TEST_OPENID" } as never,
  );
  const intent = await storedValue.createIntent(
    principal,
    {
      organizationId: organization.id,
      amountFen: 28_800,
    },
    `${prefix}-recharge`,
  );
  const recharge = await prisma.storedValueRecharge.findUniqueOrThrow({
    where: { id: intent.id },
  });
  assert.equal(recharge.amountFen, 28800n);
  assert.equal(recharge.status, "PENDING");
  assert.equal(syntheticPrepayCalls, 1);
  const accountBefore = await prisma.storedValueAccount.findUniqueOrThrow({
    where: { id: recharge.accountId },
  });
  assert.equal(accountBefore.balanceFen, 0n);
  verified(
    "288 yuan passes migrated database constraint; creating payment intent does not credit balance",
  );

  const notification = signedNotification({
    appid: identity.appId,
    mchid: identity.merchantId,
    out_trade_no: recharge.merchantPaymentNo,
    transaction_id: `LOCALTEST${randomUUID().replaceAll("-", "")}`,
    trade_type: "JSAPI",
    trade_state: "SUCCESS",
    success_time: new Date().toISOString(),
    amount: { total: 28800, currency: "CNY" },
  });
  const callback = new WechatPaymentsService(
    prisma,
    client as never,
    storedValue,
  );
  await Promise.all(
    Array.from({ length: 8 }, () =>
      callback.notify(notification.body, notification.headers),
    ),
  );
  const paidAccount = await prisma.storedValueAccount.findUniqueOrThrow({
    where: { id: recharge.accountId },
  });
  assert.equal(paidAccount.balanceFen, 28800n);
  assert.equal(
    await prisma.storedValueTransaction.count({
      where: { rechargeId: recharge.id },
    }),
    1,
  );
  const reward = await prisma.storedValueFirstRechargeReward.findUniqueOrThrow({
    where: { accountId: recharge.accountId },
  });
  assert.equal(reward.amountFen, 8800n);
  assert.equal(reward.claimedAt, null);
  verified(
    "8 identical locally signed callbacks credit 288 once and unlock an unclaimed 88 reward",
  );

  await Promise.all(
    Array.from({ length: 8 }, () =>
      storedValue.claimFirstRechargeReward(principal, organization.id),
    ),
  );
  const finalAccount = await prisma.storedValueAccount.findUniqueOrThrow({
    where: { id: recharge.accountId },
  });
  assert.equal(finalAccount.balanceFen, 37600n);
  assert.equal(
    await prisma.storedValueTransaction.count({
      where: { accountId: recharge.accountId },
    }),
    2,
  );
  assert.equal(
    await prisma.storedValueTransaction.count({
      where: { rewardId: reward.id },
    }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        organizationId: organization.id,
        action: "FIRST_RECHARGE_REWARD_CLAIMED",
      },
    }),
    1,
  );
  assert.equal(queryCalls, 0);
  verified(
    "8 concurrent manual reward claims yield one 88 ledger entry; final balance 37600 fen",
  );
  process.stdout.write(
    JSON.stringify({
      result: "passed",
      checks: proof.length,
      syntheticOnly: true,
      realWeChatCalls: 0,
      database: "localhost:55439/zydj_benefits_test",
      organizationId: organization.id,
      customerId: customer.id,
      rechargeId: recharge.id,
      finalBalanceFen: Number(finalAccount.balanceFen),
    }) + "\n",
  );
} finally {
  await prisma.$disconnect();
}

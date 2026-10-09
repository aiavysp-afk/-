import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// Fail before loading Prisma. DATABASE_URL and dotenv are deliberately unused.
const fixtureUrl = process.env.BACKEND_SYNC_TEST_DATABASE_URL;
let url;
try {
  url = new URL(fixtureUrl ?? "");
} catch {}
if (
  !url ||
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "55432" ||
  url.pathname !== "/friend_pay_tests" ||
  url.username !== "friend_pay_test" ||
  url.password !== "friend_pay_fixture_only" ||
  url.search ||
  url.hash
) {
  console.error(
    "BACKEND_SYNC_POSTGRES_REFUSED: use only the isolated 127.0.0.1:55432/friend_pay_tests fixture URL.",
  );
  process.exit(1);
}

// No bootstrap, provider clients, dotenv, external HTTP, migrations or cleanup.
globalThis.fetch = async () => {
  throw new Error("Fixture forbids external HTTP");
};
const apiRequire = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { ConfigService } = apiRequire("@nestjs/config");
const { PrismaService } = await import(
  "../apps/api/dist/database/prisma.service.js"
);
const { AccessControlService } = await import(
  "../apps/api/dist/auth/access-control.service.js"
);
const { OrderStateMachine } = await import(
  "../apps/api/dist/orders/order-state-machine.js"
);
const { OperationsDashboardService } = await import(
  "../apps/api/dist/orders/operations-dashboard.service.js"
);
const { OrderDispatchService } = await import(
  "../apps/api/dist/orders/order-dispatch.service.js"
);
const { TechnicianWorkbenchService } = await import(
  "../apps/api/dist/orders/technician-workbench.service.js"
);
const { AdminStoredValueLedgerService } = await import(
  "../apps/api/dist/customer-center/admin-stored-value-ledger.service.js"
);
const prisma = new PrismaService({ datasources: { db: { url: fixtureUrl } } });
const access = new AccessControlService(
  new ConfigService({ NODE_ENV: "test", STAFF_MFA_REQUIRED: "false" }),
);
const machine = new OrderStateMachine();
const runId = `backend-sync-fixture-${randomUUID()}`;
const id = (name) => `${runId}-${name}`;
const now = new Date();
const startsAt = new Date(now.getTime() + 60 * 60_000);
const endsAt = new Date(startsAt.getTime() + 120 * 60_000);
const principal = (name, role, organizationId = id("orgA")) => ({
  sessionId: id(`session-${name}`),
  userId: id(name),
  displayName: `Fixture ${name}`,
  memberships: [{ organizationId, role }],
});
const forbidden = (error) => error?.getStatus?.() === 403;
const reports = [];

async function order(name, overrides = {}) {
  return prisma.order.create({
    data: {
      id: id(name),
      orderNo: id(`number-${name}`),
      organizationId: id("orgA"),
      customerId: id("customerA"),
      status: "CANCELLED",
      appointmentStart: startsAt,
      appointmentEnd: endsAt,
      serviceAmountFen: 49800n,
      travelFeeFen: 0n,
      payableFen: 49800n,
      addressEncrypted: "fixture-address-not-real",
      policyVersion: "fixture-only",
      idempotencyKey: id(`key-${name}`),
      requestFingerprint: id(`fingerprint-${name}`),
      items: {
        create: {
          serviceId: id("service"),
          serviceName: "Fixture SPA",
          durationMinutes: 120,
          unitPriceFen: 49800n,
        },
      },
      ...overrides,
    },
  });
}
async function payment(orderId, name, overrides = {}) {
  return prisma.payment.create({
    data: {
      id: id(`payment-${name}`),
      orderId,
      provider: "WECHAT",
      status: "SUCCEEDED",
      merchantPaymentNo: id(`merchant-${name}`),
      amountFen: 49800n,
      succeededAt: now,
      ...overrides,
    },
  });
}

try {
  const [database] =
    await prisma.$queryRaw`SELECT current_database() AS database, current_user AS username`;
  assert.equal(database.database, "friend_pay_tests");
  assert.equal(database.username, "friend_pay_test");
  const migrations =
    await prisma.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
  assert.equal(
    migrations.length,
    33,
    "Expected already-deployed fixture migrations; never auto-migrate",
  );
  assert.equal(
    migrations.at(-1).migration_name,
    "20261010060000_friend_payments",
  );
  reports.push("isolated database/user + 33 pre-existing migrations");

  for (const name of ["orgA", "orgB"])
    await prisma.organization.create({
      data: { id: id(name), name: `Fixture ${name}` },
    });
  for (const [name, role, org] of [
    ["customerA", "CUSTOMER", "orgA"],
    ["customerB", "CUSTOMER", "orgB"],
    ["payer", "CUSTOMER", "orgA"],
    ["own", "THERAPIST", "orgA"],
    ["busy", "THERAPIST", "orgA"],
    ["available", "THERAPIST", "orgA"],
    ["admin", "ADMIN", "orgA"],
    ["finance", "FINANCE_REQUESTER", "orgA"],
  ])
    await prisma.user.create({
      data: {
        id: id(name),
        displayName: `Fixture ${name}`,
        role,
        organizationId: id(org),
      },
    });
  await prisma.service.create({
    data: {
      id: id("service"),
      organizationId: id("orgA"),
      slug: id("spa"),
      name: "Fixture SPA",
      category: "SPA_RELAXATION",
      subtitle: "Test only",
      description: "No actual service or payment",
      durationMinutes: 120,
      priceFen: 49800n,
      steps: [],
      boundaries: ["Fixture only"],
    },
  });

  const late = await order("late");
  await payment(late.id, "late", {
    failureCode: "FULFILLMENT_REVIEW_REQUIRED",
  });
  const stopped = await order("stopped", {
    status: "PENDING_PAYMENT",
    createdAt: new Date(now.getTime() - 120_000),
    paymentExpiresAt: new Date(now.getTime() - 60_000),
  });
  await payment(stopped.id, "stopped", {
    status: "PENDING",
    succeededAt: null,
    recoveryReviewAt: now,
  });
  const refunded = await order("refunded");
  await prisma.$transaction(async (tx) => {
    const full = await tx.payment.create({
      data: {
        id: id("payment-refunded"),
        orderId: refunded.id,
        provider: "WECHAT",
        // Deliberately retain SUCCEEDED to exercise the database field-reference filter.
        status: "SUCCEEDED",
        merchantPaymentNo: id("merchant-refunded"),
        amountFen: 49800n,
        refundedFen: 49800n,
        succeededAt: now,
        failureCode: "FULFILLMENT_REVIEW_REQUIRED",
      },
    });
    await tx.refund.create({
      data: {
        id: id("refund"),
        paymentId: full.id,
        merchantRefundNo: id("merchant-refund"),
        amountFen: 49800n,
        status: "SUCCEEDED",
        reason: "LATE_PAYMENT",
        policyVersion: "fixture-only",
        requestedById: id("finance"),
        idempotencyKey: id("refund-key"),
        requestFingerprint: id("refund-fingerprint"),
        reviewedById: id("admin"),
        reviewedAt: now,
        reviewCode: "CONFIRMED",
        submittedAt: now,
        providerRefundId: id("provider-refund"),
        succeededAt: now,
        posting: { create: { amountFen: 49800n } },
      },
    });
  });
  const otherOrg = await order("other-org", {
    organizationId: id("orgB"),
    customerId: id("customerB"),
  });
  await payment(otherOrg.id, "other-org", {
    failureCode: "FULFILLMENT_REVIEW_REQUIRED",
  });
  const dashboard = await new OperationsDashboardService(prisma, access).get(
    principal("admin", "ADMIN"),
    id("orgA"),
    now,
  );
  assert.equal(
    dashboard.metrics.attentionRequired,
    2,
    "Late review + stopped recovery counted once; full refund and foreign org excluded",
  );
  reports.push(
    "dashboard field-reference/full-refund filter + stopped-recovery deduplication + organization isolation",
  );

  for (const name of ["own", "busy", "available"]) {
    await prisma.staffMembership.create({
      data: { userId: id(name), organizationId: id("orgA"), role: "THERAPIST" },
    });
    await prisma.therapistShift.create({
      data: {
        organizationId: id("orgA"),
        therapistId: id(name),
        startsAt: now,
        endsAt: new Date(endsAt.getTime() + 60_000),
        createdById: id("admin"),
      },
    });
  }
  for (const [name, therapist, start, end] of [
    ["reservation-own", "own", startsAt, endsAt],
    ["reservation-busy", "busy", startsAt, endsAt],
    [
      "reservation-adjacent",
      "available",
      new Date(startsAt.getTime() - 30 * 60_000),
      startsAt,
    ],
  ])
    await prisma.appointmentReservation.create({
      data: {
        id: id(name),
        organizationId: id("orgA"),
        serviceId: id("service"),
        therapistId: id(therapist),
        customerId: id("customerA"),
        serviceAmountFen: 49800n,
        startsAt: start,
        endsAt: end,
        expiresAt: endsAt,
        status: "CONFIRMED",
      },
    });
  const assigned = await order("assigned", {
    status: "PAID",
    therapistId: id("own"),
    reservationId: id("reservation-own"),
  });
  await payment(assigned.id, "assigned", {
    kind: "FRIEND",
    payerUserId: id("payer"),
    payerOpenIdHash: id("private-payer-hash"),
  });
  const dispatch = new OrderDispatchService(prisma, access, machine);
  const board = await dispatch.getBoard(
    principal("admin", "ADMIN"),
    id("orgA"),
    now,
  );
  assert.deepEqual(
    board.orders
      .find((row) => row.id === assigned.id)
      .eligibleTherapists.map((row) => row.id)
      .sort(),
    [id("own"), id("available")].sort(),
  );
  await assert.rejects(
    dispatch.assign(
      principal("admin", "ADMIN"),
      id("orgA"),
      assigned.id,
      { therapistId: id("busy") },
      now,
    ),
    (error) => error?.getStatus?.() === 409,
  );
  assert.equal(
    (await prisma.order.findUniqueOrThrow({ where: { id: assigned.id } }))
      .status,
    "PAID",
  );
  reports.push(
    "dispatch own-reservation exemption + actual overlap exclusion + adjacent boundary + submit-time conflict protection",
  );

  const workbench = await new TechnicianWorkbenchService(
    prisma,
    access,
    machine,
  ).get(principal("own", "THERAPIST"), now);
  const technicianOrder = workbench.orders.find(
    (row) => row.id === assigned.id,
  );
  assert.deepEqual(technicianOrder.payment, {
    kind: "FRIEND",
    status: "SUCCEEDED",
    succeededAt: now.toISOString(),
  });
  assert.deepEqual(Object.keys(technicianOrder.payment).sort(), [
    "kind",
    "status",
    "succeededAt",
  ]);
  assert.ok(!JSON.stringify(workbench).includes(id("payer")));
  assert.ok(!JSON.stringify(workbench).includes(id("private-payer-hash")));
  assert.ok(workbench.orders.every((row) => row.id === assigned.id));
  reports.push(
    "technician real payment summary + payer privacy + assigned-order scope",
  );

  for (const [name, customer, org, balance] of [
    ["accountA", "customerA", "orgA", 37500n],
    ["accountB", "customerB", "orgB", 99999n],
  ])
    await prisma.storedValueAccount.create({
      data: {
        id: id(name),
        organizationId: id(org),
        customerId: id(customer),
        balanceFen: balance,
      },
    });
  await prisma.storedValueRecharge.create({
    data: {
      id: id("recharge"),
      organizationId: id("orgA"),
      customerId: id("customerA"),
      accountId: id("accountA"),
      amountFen: 28800n,
      status: "SUCCEEDED",
      merchantPaymentNo: id("recharge-merchant"),
      providerTransactionId: id("recharge-transaction"),
      prepayState: "READY",
      succeededAt: now,
      idempotencyKey: id("recharge-key"),
      requestFingerprint: id("recharge-fingerprint"),
      expiresAt: endsAt,
    },
  });
  await prisma.storedValueFirstRechargeReward.create({
    data: {
      id: id("reward"),
      accountId: id("accountA"),
      rechargeId: id("recharge"),
      amountFen: 8800n,
      claimedAt: now,
    },
  });
  for (const row of [
    {
      type: "RECHARGE",
      changeFen: 28800n,
      balanceAfterFen: 28800n,
      rechargeId: id("recharge"),
    },
    {
      type: "FIRST_RECHARGE_REWARD",
      changeFen: 8800n,
      balanceAfterFen: 37600n,
      rewardId: id("reward"),
    },
    { type: "FIXTURE_ADJUSTMENT", changeFen: -100n, balanceAfterFen: 37500n },
  ])
    await prisma.storedValueTransaction.create({
      data: { accountId: id("accountA"), description: "Fixture only", ...row },
    });
  const ledgerService = new AdminStoredValueLedgerService(prisma, access);
  const ledger = await ledgerService.get(
    principal("finance", "FINANCE_REQUESTER"),
    id("orgA"),
    { limit: 50 },
  );
  assert.deepEqual(ledger.summary, {
    balanceFen: 37500,
    successfulRechargeFen: 28800,
    successfulRechargeCount: 1,
  });
  assert.equal(ledger.recharges[0].id, id("recharge"));
  assert.equal(
    ledger.transactions.find((row) => row.rewardId === id("reward")).changeFen,
    8800,
  );
  assert.equal(
    ledger.transactions.find((row) => row.type === "FIXTURE_ADJUSTMENT")
      .changeFen,
    -100,
  );
  assert.ok(!JSON.stringify(ledger).includes(id("customerB")));
  const limited = await ledgerService.get(
    principal("finance", "FINANCE_REQUESTER"),
    id("orgA"),
    { limit: 1 },
  );
  assert.equal(limited.transactions.length, 1);
  assert.equal(limited.hasMore.transactions, true);
  const foreignCustomer = await ledgerService.get(
    principal("finance", "FINANCE_REQUESTER"),
    id("orgA"),
    { limit: 50, customerId: id("customerB") },
  );
  assert.equal(foreignCustomer.summary.balanceFen, 0);
  assert.equal(
    foreignCustomer.accounts.length +
      foreignCustomer.recharges.length +
      foreignCustomer.transactions.length,
    0,
  );
  await assert.rejects(
    ledgerService.get(principal("own", "THERAPIST"), id("orgA"), { limit: 50 }),
    forbidden,
  );
  await assert.rejects(
    ledgerService.get(principal("admin", "OPERATOR"), id("orgA"), {
      limit: 50,
    }),
    forbidden,
  );
  await assert.rejects(
    ledgerService.get(
      principal("finance", "FINANCE_REQUESTER", id("orgB")),
      id("orgA"),
      { limit: 50 },
    ),
    forbidden,
  );
  reports.push(
    "ledger recharge/reward includes + signed amount + bounded list + customer/org isolation + finance-only authorization",
  );
  console.log(
    JSON.stringify({ ok: true, fixture: runId, checks: reports }, null, 2),
  );
} finally {
  await prisma.$disconnect();
  // Preserve every pre-existing row and these uniquely namespaced fixtures. Caller restores container state.
}

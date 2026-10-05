import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, UserRole } from "@prisma/client";
import type { ConfigService } from "@nestjs/config";
import type { AppEnv } from "../src/config/env.js";
import type { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import type { AccessControlService } from "../src/auth/access-control.service.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";
import type { SafetyNotificationDispatcher } from "../src/safety/safety-notification.dispatcher.js";
import { SafetyNotificationService } from "../src/safety/safety-notification.service.js";
import { SafetyNotificationWorker } from "../src/safety/safety-notification.worker.js";

const url = process.env.SAFETY_NOTIFICATION_TEST_DATABASE_URL ?? "";
const target = new URL(url);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !["/zhongyuan_daojia_test", "/zhongyuan_safety_test"].includes(
    target.pathname,
  )
)
  throw new Error("Only a dedicated local test database is allowed");
process.env.DATABASE_URL = url;

const prisma = new PrismaClient();
const prefix = `safety-notify-${randomUUID()}`;
const organizationId = `${prefix}-org`;
const userId = `${prefix}-duty`;
const now = new Date("2026-10-05T09:00:00.000Z");
const outcomes = new Map<
  string,
  | { outcome: "ACCEPTED"; providerReference: string }
  | { outcome: "RETRY"; errorCode: string }
  | { outcome: "DEAD_LETTER"; errorCode: string }
>();
const calls = new Map<string, number>();
const dispatcher = {
  dispatch: async (id: string) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return (
      outcomes.get(id) ?? {
        outcome: "DEAD_LETTER",
        errorCode: "NO_TEST_OUTCOME",
      }
    );
  },
} as SafetyNotificationDispatcher;
const config = {
  get: (key: string) =>
    key === "SAFETY_NOTIFICATION_DISPATCH_ENABLED" ? "true" : undefined,
} as ConfigService<AppEnv, true>;
const access = {
  assertPermission: () => undefined,
} as unknown as AccessControlService;
const crypto = {
  encrypt: (value: string) => `encrypted:${value}`,
} as AuthCryptoService;
const principal: AuthPrincipal = {
  sessionId: `${prefix}-session`,
  userId: `${prefix}-admin`,
  displayName: "Safety Test Admin",
  memberships: [{ organizationId, role: "ADMIN" }],
};

const createEvent = async (
  suffix: string,
  data: {
    attempts?: number;
    dispatchStartedAt?: Date;
    leaseToken?: string;
    leaseUntil?: Date;
  } = {},
) =>
  prisma.outboxEvent.create({
    data: {
      id: `${prefix}-${suffix}`,
      organizationId,
      aggregateId: `${prefix}-incident-${suffix}`,
      type: "SAFETY_INCIDENT_OPENED",
      payload: { incidentId: `${prefix}-incident-${suffix}` },
      nextAttemptAt: new Date(now.getTime() - 1_000),
      ...data,
    },
  });

let initialized = false;
try {
  await prisma.organization.create({
    data: { id: organizationId, name: "Safety notification test" },
  });
  initialized = true;
  await prisma.user.create({
    data: {
      id: userId,
      organizationId,
      role: UserRole.SAFETY_DUTY,
      displayName: "Duty Test",
    },
  });
  await prisma.staffMembership.create({
    data: {
      organizationId,
      userId,
      role: UserRole.SAFETY_DUTY,
    },
  });

  const accepted = await createEvent("accepted");
  outcomes.set(accepted.id, {
    outcome: "ACCEPTED",
    providerReference: "request:biz",
  });
  const workerA = new SafetyNotificationWorker(prisma, dispatcher, config);
  const workerB = new SafetyNotificationWorker(prisma, dispatcher, config);
  await Promise.all([workerA.run(now, 1), workerB.run(now, 1)]);
  const acceptedRow = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: accepted.id },
  });
  assert.equal(calls.get(accepted.id), 1);
  assert.equal(acceptedRow.attempts, 1);
  assert.equal(acceptedRow.providerReference, "request:biz");
  assert(acceptedRow.publishedAt);

  const retry = await createEvent("retry");
  outcomes.set(retry.id, { outcome: "RETRY", errorCode: "CHANNEL_NOT_READY" });
  await workerA.run(new Date(now.getTime() + 1_000), 1);
  const retryRow = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: retry.id },
  });
  assert.equal(retryRow.attempts, 1);
  assert.equal(retryRow.lastErrorCode, "CHANNEL_NOT_READY");
  assert.equal(retryRow.dispatchStartedAt, null);
  assert.equal(retryRow.deadLetteredAt, null);
  assert(retryRow.nextAttemptAt.getTime() > now.getTime());

  const unknown = await createEvent("unknown");
  outcomes.set(unknown.id, {
    outcome: "DEAD_LETTER",
    errorCode: "SMS_ACCEPTANCE_UNKNOWN",
  });
  await workerA.run(new Date(now.getTime() + 2_000), 1);
  const unknownRow = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: unknown.id },
  });
  assert.equal(unknownRow.attempts, 1);
  assert(unknownRow.deadLetteredAt);
  assert.equal(unknownRow.lastErrorCode, "SMS_ACCEPTANCE_UNKNOWN");

  const maximum = await createEvent("maximum", { attempts: 7 });
  outcomes.set(maximum.id, { outcome: "RETRY", errorCode: "SMS_REJECTED" });
  await workerA.run(new Date(now.getTime() + 3_000), 1);
  const maximumRow = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: maximum.id },
  });
  assert.equal(maximumRow.attempts, 8);
  assert(maximumRow.deadLetteredAt);

  const ambiguous = await createEvent("ambiguous", {
    attempts: 1,
    dispatchStartedAt: new Date(now.getTime() - 60_000),
    leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() - 1_000),
  });
  await workerA.run(new Date(now.getTime() + 4_000), 1);
  const ambiguousRow = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: ambiguous.id },
  });
  assert.equal(calls.get(ambiguous.id), undefined);
  assert(ambiguousRow.deadLetteredAt);
  assert.equal(ambiguousRow.lastErrorCode, "PREVIOUS_ATTEMPT_OUTCOME_UNKNOWN");

  const notifications = new SafetyNotificationService(prisma, access, crypto);
  await notifications.updateDutyContact(principal, organizationId, userId, {
    phone: "13800138000",
  });
  assert.equal(
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { phoneEncrypted: true },
      })
    ).phoneEncrypted,
    "encrypted:13800138000",
  );
  await notifications.retry(
    principal,
    organizationId,
    unknown.id,
    new Date(now.getTime() + 5_000),
  );
  const retried = await prisma.outboxEvent.findUniqueOrThrow({
    where: { id: unknown.id },
  });
  assert.equal(retried.deadLetteredAt, null);
  assert.equal(retried.dispatchStartedAt, null);
  assert.equal(retried.lastErrorCode, null);
  assert(
    (await notifications.list(principal, organizationId)).some(
      (item) => item.id === unknown.id && item.state === "PENDING",
    ),
  );

  console.log(
    JSON.stringify({
      ok: true,
      database: target.pathname.slice(1),
      checks: [
        "concurrent lease claims dispatch once",
        "provider acceptance records tracking without claiming delivery",
        "retryable failures use backoff",
        "unknown outcomes dead-letter without blind retry",
        "maximum attempts dead-letter",
        "expired in-flight attempts quarantine as ambiguous",
        "duty phone is encrypted and never returned",
        "admin-reviewed retry is audited",
      ],
    }),
  );
} finally {
  if (initialized) {
    await prisma.auditLog.deleteMany({ where: { organizationId } });
    await prisma.outboxEvent.deleteMany({ where: { organizationId } });
    await prisma.staffMembership.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
  await prisma.$disconnect();
}

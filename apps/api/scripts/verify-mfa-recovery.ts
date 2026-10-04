import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { PrismaClient, type UserRole } from "@prisma/client";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { decodeSecret, hotp } from "../src/auth/totp.js";

const databaseUrl = process.env.MFA_RECOVERY_TEST_DATABASE_URL;
if (!databaseUrl)
  throw Error(
    "Set MFA_RECOVERY_TEST_DATABASE_URL for an isolated test database",
  );
const targetDatabase = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(targetDatabase.hostname) ||
  !(
    targetDatabase.pathname === "/zhongyuan_daojia_test" ||
    (process.env.CONFIRM_PRIVATE_ACCEPTANCE_TEST === "true" &&
      targetDatabase.pathname === "/zydj_acceptance_smoke" &&
      targetDatabase.username === "zydj_acceptance")
  )
)
  throw Error("Refusing non-dedicated MFA recovery test database");

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  AUTH_PROVIDER: "mock",
  PAYMENT_PROVIDER: "mock",
  STAFF_MFA_REQUIRED: "true",
  STAFF_BROWSER_LOGIN_ENABLED: "true",
  WECHAT_PAY_PREPAY_ENABLED: "false",
  WECHAT_PAY_REFUND_ENABLED: "false",
  WECHAT_PAY_RECOVERY_ENABLED: "false",
  AUTH_SESSION_PEPPER: `test-mfa-recovery-${randomUUID()}`,
  DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
});

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
  logger: false,
  rawBody: true,
});
app.setGlobalPrefix("v1");
await app.listen(0, "127.0.0.1");

const base = `${await app.getUrl()}/v1`;
const prefix = `mfa-recovery-test-${randomUUID()}`;
const crypto = new AuthCryptoService(app.get(ConfigService));
const appId = app.get(ConfigService).get("WECHAT_MINIAPP_APP_ID");
const users: string[] = [];
const organizations: string[] = [];
let passed = false;

type Actor = {
  id: string;
  code: string;
  token: string;
  role: UserRole;
  secret?: string;
};

async function call(path: string, token = "", body?: unknown, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status,
    expected,
    `${path}; sensitive response omitted`,
  );
  if (expected === 200 && path.includes("mfa/recovery-requests"))
    assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = (await response.json()) as { data?: unknown };
  return payload.data as any;
}

async function login(code: string) {
  return (await call("/auth/wechat-miniapp", "", { code }))
    .accessToken as string;
}

async function actor(
  organizationId: string,
  role: UserRole,
  suffix: string,
): Promise<Actor> {
  const code = `${prefix}-${suffix}`;
  const openId = `mock-${createHash("sha256").update(code).digest("hex").slice(0, 32)}`;
  const user = await prisma.user.create({
    data: {
      role,
      displayName: suffix,
      memberships: { create: { organizationId, role } },
      identities: {
        create: {
          provider: "WECHAT_MINIAPP",
          subjectHash: crypto.hashIdentity(appId, openId),
          subjectEncrypted: crypto.encrypt(openId),
        },
      },
    },
  });
  users.push(user.id);
  return { id: user.id, code, token: await login(code), role };
}

function otp(secret: string) {
  return hotp(decodeSecret(secret), BigInt(Math.floor(Date.now() / 30_000)));
}

async function activateMfa(subject: Actor) {
  const enrollment = await call("/auth/mfa/enrollment", subject.token, {});
  subject.secret = enrollment.secret as string;
  await call("/auth/mfa/activate", subject.token, {
    code: otp(subject.secret),
  });
}

async function createRequest(subject: Actor, organizationId: string) {
  return call("/auth/mfa/recovery-requests", subject.token, {
    organizationId,
  });
}

const reviewPath = (organizationId: string, requestId: string) =>
  `/admin/organizations/${organizationId}/mfa-recovery-requests/${requestId}`;

try {
  const org = await prisma.organization.create({ data: { name: prefix } });
  const otherOrg = await prisma.organization.create({
    data: { name: `${prefix}-other` },
  });
  organizations.push(org.id, otherOrg.id);

  const reviewerOne = await actor(org.id, "ADMIN", "reviewer-one");
  const reviewerTwo = await actor(org.id, "ADMIN", "reviewer-two");
  const outsider = await actor(otherOrg.id, "ADMIN", "outsider");
  await activateMfa(reviewerOne);
  await activateMfa(reviewerTwo);
  await activateMfa(outsider);

  const noMfaReviewer = await actor(org.id, "ADMIN", "reviewer-no-mfa");
  const target = await actor(org.id, "ADMIN", "approval-target");
  await activateMfa(target);
  const targetSecondToken = await login(target.code);

  await call(
    "/auth/mfa/recovery-requests",
    target.token,
    { organizationId: org.id, targetUserId: target.id },
    400,
  );
  const requestResponses = await Promise.all(
    [0, 1].map(() =>
      fetch(base + "/auth/mfa/recovery-requests", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId: org.id }),
      }),
    ),
  );
  assert.deepEqual(
    requestResponses.map((response) => response.status).sort(),
    [200, 409],
  );
  const successfulRequest = requestResponses.find(
    (response) => response.status === 200,
  )!;
  const approvalRequest = ((await successfulRequest.json()) as { data: any })
    .data;
  assert.equal(approvalRequest.status, "PENDING");
  await call(
    `${reviewPath(org.id, approvalRequest.id)}/approve`,
    target.token,
    {},
    403,
  );
  await call(
    `${reviewPath(org.id, approvalRequest.id)}/approve`,
    noMfaReviewer.token,
    {},
    403,
  );
  await call(
    `${reviewPath(org.id, approvalRequest.id)}/approve`,
    outsider.token,
    {},
    403,
  );
  const queue = await call(
    `/admin/organizations/${org.id}/mfa-recovery-requests`,
    reviewerOne.token,
  );
  assert.ok(
    queue.some((item: { id: string }) => item.id === approvalRequest.id),
  );

  const approvals = await Promise.all([
    fetch(base + `${reviewPath(org.id, approvalRequest.id)}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerOne.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    fetch(base + `${reviewPath(org.id, approvalRequest.id)}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerTwo.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  ]);
  assert.deepEqual(
    approvals.map((response) => response.status).sort(),
    [200, 409],
  );
  const approved = await prisma.mfaRecoveryRequest.findUniqueOrThrow({
    where: { id: approvalRequest.id },
  });
  assert.equal(approved.status, "APPROVED");
  assert.notEqual(approved.reviewerUserId, target.id);
  assert.equal(
    await prisma.mfaCredential.findUnique({ where: { userId: target.id } }),
    null,
  );
  assert.equal(
    await prisma.session.count({
      where: { userId: target.id, revokedAt: null },
    }),
    0,
  );
  await call("/auth/me", target.token, undefined, 401);
  await call("/auth/me", targetSecondToken, undefined, 401);

  target.token = await login(target.code);
  await activateMfa(target);
  assert.ok(
    (await prisma.mfaCredential.findUnique({ where: { userId: target.id } }))
      ?.enabledAt,
  );

  const rejectedTarget = await actor(org.id, "OPERATOR", "rejected-target");
  await activateMfa(rejectedTarget);
  const rejectedRequest = await createRequest(rejectedTarget, org.id);
  await call(
    `${reviewPath(org.id, rejectedRequest.id)}/reject`,
    reviewerOne.token,
    {
      reasonCode: "IDENTITY_NOT_CONFIRMED",
    },
  );
  assert.ok(
    (
      await prisma.mfaCredential.findUnique({
        where: { userId: rejectedTarget.id },
      })
    )?.enabledAt,
  );
  await call("/auth/me", rejectedTarget.token);
  await assert.rejects(
    prisma.mfaRecoveryRequest.update({
      where: { id: rejectedRequest.id },
      data: { status: "PENDING" },
    }),
  );

  const cancelledTarget = await actor(org.id, "OPERATOR", "cancelled-target");
  await activateMfa(cancelledTarget);
  const cancelledSecondToken = await login(cancelledTarget.code);
  const cancelledRequest = await createRequest(cancelledTarget, org.id);
  await call(
    `/auth/mfa/recovery-requests/${cancelledRequest.id}/cancel`,
    cancelledSecondToken,
    {},
    401,
  );
  const cancelled = await call(
    `/auth/mfa/recovery-requests/${cancelledRequest.id}/cancel`,
    cancelledTarget.token,
    {},
  );
  assert.equal(cancelled.status, "CANCELLED");

  const staleTarget = await actor(org.id, "OPERATOR", "stale-target");
  await activateMfa(staleTarget);
  await prisma.session.updateMany({
    where: { userId: staleTarget.id },
    data: { createdAt: new Date(Date.now() - 300_001) },
  });
  await call(
    "/auth/mfa/recovery-requests",
    staleTarget.token,
    { organizationId: org.id },
    401,
  );

  const rateTarget = await actor(org.id, "OPERATOR", "rate-target");
  await activateMfa(rateTarget);
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = await createRequest(rateTarget, org.id);
    await call(
      `/auth/mfa/recovery-requests/${request.id}/cancel`,
      rateTarget.token,
      {},
    );
  }
  await call(
    "/auth/mfa/recovery-requests",
    rateTarget.token,
    { organizationId: org.id },
    429,
  );

  const loggedOutTarget = await actor(org.id, "OPERATOR", "logged-out-target");
  await activateMfa(loggedOutTarget);
  const loggedOutRequest = await createRequest(loggedOutTarget, org.id);
  await call("/auth/logout", loggedOutTarget.token, {});
  await call(
    `${reviewPath(org.id, loggedOutRequest.id)}/approve`,
    reviewerOne.token,
    {},
    409,
  );

  const removedTarget = await actor(org.id, "OPERATOR", "removed-target");
  await activateMfa(removedTarget);
  const removedRequest = await createRequest(removedTarget, org.id);
  await prisma.staffMembership.updateMany({
    where: { userId: removedTarget.id, organizationId: org.id },
    data: { status: "SUSPENDED" },
  });
  await call(
    `${reviewPath(org.id, removedRequest.id)}/approve`,
    reviewerOne.token,
    {},
    403,
  );

  const expiredTarget = await actor(org.id, "OPERATOR", "expired-target");
  await activateMfa(expiredTarget);
  const expiredRequest = await createRequest(expiredTarget, org.id);
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "MfaRecoveryRequest" DISABLE TRIGGER "MfaRecoveryRequest_guard"',
  );
  try {
    await prisma.mfaRecoveryRequest.update({
      where: { id: expiredRequest.id },
      data: {
        createdAt: new Date(Date.now() - 31 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "MfaRecoveryRequest" ENABLE TRIGGER "MfaRecoveryRequest_guard"',
    );
  }
  await call(
    `${reviewPath(org.id, expiredRequest.id)}/approve`,
    reviewerOne.token,
    {},
    409,
  );
  assert.equal(
    (
      await prisma.mfaRecoveryRequest.findUniqueOrThrow({
        where: { id: expiredRequest.id },
      })
    ).status,
    "EXPIRED",
  );
  await assert.rejects(
    prisma.mfaRecoveryRequest.update({
      where: { id: expiredRequest.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    }),
  );

  const audit = await prisma.auditLog.findMany({
    where: { actorId: { in: users } },
  });
  const auditText = JSON.stringify(audit);
  for (const subject of [
    target,
    reviewerOne,
    reviewerTwo,
    outsider,
    rejectedTarget,
  ]) {
    assert.equal(auditText.includes(subject.token), false);
    if (subject.secret) assert.equal(auditText.includes(subject.secret), false);
  }
  assert.ok(audit.some((entry) => entry.action === "MFA_RECOVERY_REQUESTED"));
  assert.ok(audit.some((entry) => entry.action === "MFA_RECOVERY_APPROVED"));
  assert.ok(audit.some((entry) => entry.action === "MFA_RECOVERY_REJECTED"));
  assert.ok(audit.some((entry) => entry.action === "MFA_RECOVERY_CANCELLED"));

  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks: [
        "fresh WeChat session and active-factor request gate",
        "strict schema, concurrent one-pending guard, rate limit and thirty-minute expiry",
        "same-organization MFA administrator review and self-review denial",
        "concurrent exactly-once approval",
        "factor removal, complete target-session revocation and clean re-enrollment",
        "rejection and original-session-only cancellation",
        "source-session and membership revalidation",
        "terminal-state database guard and secret-free audit",
      ],
      mode: "isolated HTTP/PostgreSQL; synthetic identities only",
    }),
  );
} finally {
  await app.close();
  await prisma.mfaRecoveryRequest.deleteMany({
    where: { targetUserId: { in: users } },
  });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.organization.deleteMany({
    where: { id: { in: organizations } },
  });
  await prisma.$disconnect();
  console.log(JSON.stringify({ syntheticFixturesRemoved: true, passed }));
}

import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { PrismaClient, type UserRole } from "@prisma/client";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { decodeSecret, hotp } from "../src/auth/totp.js";

const databaseUrl = process.env.MFA_TEST_DATABASE_URL;
if (!databaseUrl)
  throw Error("Set MFA_TEST_DATABASE_URL for an isolated local test database");
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
  throw Error("Refusing non-dedicated test database");
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  AUTH_PROVIDER: "mock",
  PAYMENT_PROVIDER: "mock",
  STAFF_MFA_REQUIRED: "true",
  WECHAT_PAY_PREPAY_ENABLED: "false",
  WECHAT_PAY_REFUND_ENABLED: "false",
  WECHAT_PAY_RECOVERY_ENABLED: "false",
  AUTH_SESSION_PEPPER: `test-only-${randomUUID()}`,
  DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
});
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
  logger: false,
  rawBody: true,
});
app.setGlobalPrefix("v1");
await app.listen(0, "127.0.0.1");
const base = `${await app.getUrl()}/v1`,
  prefix = `mfa-test-${randomUUID()}`;
const crypto = new AuthCryptoService(app.get(ConfigService)),
  appId = app.get(ConfigService).get("WECHAT_MINIAPP_APP_ID");
const users: string[] = [];
let org: string | undefined,
  passed = false;
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
    `${path} status; response body intentionally omitted to protect provisioning material`,
  );
  if (path.startsWith("/auth/mfa") && expected === 200)
    assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).data;
}
async function actor(role: UserRole, suffix: string) {
  const code = `${prefix}-${suffix}`,
    openId = `mock-${createHash("sha256").update(code).digest("hex").slice(0, 32)}`;
  const user = await prisma.user.create({
    data: {
      role,
      displayName: suffix,
      ...(role === "CUSTOMER"
        ? {}
        : { memberships: { create: { organizationId: org!, role } } }),
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
  const login = await call("/auth/wechat-miniapp", "", { code });
  assert.equal(login.user.id, user.id);
  return { id: user.id, token: login.accessToken as string, code };
}
function otp(secret: string, step = BigInt(Math.floor(Date.now() / 30_000))) {
  return hotp(decodeSecret(secret), step);
}
async function nextOtp(id: string, secret: string) {
  const c = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: id },
  });
  const current = BigInt(Math.floor(Date.now() / 30_000));
  return otp(
    secret,
    c.lastAcceptedStep !== null && c.lastAcceptedStep >= current
      ? c.lastAcceptedStep + 1n
      : current,
  );
}
try {
  org = (await prisma.organization.create({ data: { name: prefix } })).id;
  const operator = await actor("OPERATOR", "operator"),
    finance = await actor("FINANCE_REQUESTER", "finance"),
    customer = await actor("CUSTOMER", "customer");
  await call("/auth/mfa", "", undefined, 401);
  await call("/auth/mfa/enrollment", customer.token, {}, 403);
  await call(
    `/admin/catalog/services?organizationId=${org}`,
    operator.token,
    undefined,
    403,
  );
  const second = (
    await call("/auth/wechat-miniapp", "", { code: operator.code })
  ).accessToken as string;
  const pending = await call("/auth/mfa/enrollment", operator.token, {});
  const credential = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: operator.id },
  });
  assert.notEqual(credential.secretEncrypted, pending.secret);
  assert.equal(crypto.decrypt(credential.secretEncrypted), pending.secret);
  await call("/auth/mfa/enrollment", operator.token, {}, 409);
  await call("/auth/mfa/activate", operator.token, { code: "12345" }, 400);
  await call(
    "/auth/mfa/activate",
    operator.token,
    { code: otp(pending.secret), verifiedUntil: "2099" },
    400,
  );
  await call("/auth/mfa/activate", second, { code: otp(pending.secret) }, 401);
  await call("/auth/mfa/activate", operator.token, {
    code: otp(pending.secret),
  });
  await call(`/admin/catalog/services?organizationId=${org}`, operator.token);
  await call(
    `/admin/catalog/services?organizationId=${org}`,
    second,
    undefined,
    403,
  );
  const replay = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: operator.id },
  });
  await call(
    "/auth/mfa/verify",
    second,
    { code: otp(pending.secret, replay.lastAcceptedStep!) },
    401,
  );
  const code = await nextOtp(operator.id, pending.secret);
  const concurrent = await Promise.all(
    [second, operator.token].map((token) =>
      fetch(base + "/auth/mfa/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 401]);
  assert.equal(
    (
      await prisma.mfaCredential.findUniqueOrThrow({
        where: { userId: operator.id },
      })
    ).lastAcceptedStep,
    replay.lastAcceptedStep! + 1n,
  );
  await prisma.session.updateMany({
    where: { userId: operator.id },
    data: { mfaVerifiedUntil: new Date(Date.now() - 1) },
  });
  await call(
    `/admin/catalog/services?organizationId=${org}`,
    operator.token,
    undefined,
    403,
  );
  // Denial counters persist despite HTTP errors and across independent sessions/requests.
  let wrong = "000000";
  const current = BigInt(Math.floor(Date.now() / 30_000));
  const candidates = [-1n, 0n, 1n].map((d) => otp(pending.secret, current + d));
  while (candidates.includes(wrong))
    wrong = (Number(wrong) + 1).toString().padStart(6, "0");
  const beforeLock = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: operator.id },
  });
  for (let i = beforeLock.failedAttempts; i < 5; i++)
    await call("/auth/mfa/verify", second, { code: wrong }, 401);
  const locked = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: operator.id },
  });
  assert.equal(locked.failedAttempts, 5);
  assert.ok(locked.lockedUntil! > new Date());
  await call(
    "/auth/mfa/verify",
    operator.token,
    { code: otp(pending.secret) },
    401,
  );
  await call("/auth/mfa/enrollment", operator.token, {}, 401);
  await prisma.mfaCredential.update({
    where: { userId: operator.id },
    data: { lockedUntil: new Date(Date.now() - 1) },
  });
  await prisma.mfaCredential.update({
    where: { userId: operator.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  await call("/auth/mfa/enrollment", operator.token, {}, 409);
  await assert.rejects(
    prisma.mfaCredential.update({
      where: { userId: operator.id },
      data: { secretEncrypted: crypto.encrypt(pending.secret) },
    }),
  );
  await assert.rejects(
    prisma.mfaCredential.update({
      where: { userId: operator.id },
      data: { lastAcceptedStep: 0n },
    }),
  );
  await assert.rejects(
    prisma.mfaCredential.update({
      where: { userId: operator.id },
      data: { failedAttempts: 6 },
    }),
  );
  const session = await prisma.session.findFirstOrThrow({
    where: { userId: operator.id },
  });
  await assert.rejects(
    prisma.session.update({
      where: { id: session.id },
      data: { mfaVerifiedUntil: new Date(session.expiresAt.getTime() + 1) },
    }),
  );
  const financePending = await call("/auth/mfa/enrollment", finance.token, {});
  await call("/auth/mfa/activate", finance.token, {
    code: otp(financePending.secret),
  });
  await call(`/admin/organizations/${org}/payments`, finance.token);
  await call(
    `/admin/organizations/${org}/refunds/not-found/approve`,
    finance.token,
    { code: "CONFIRMED" },
    403,
  );
  await call(
    `/admin/organizations/not-${org}/payments`,
    finance.token,
    undefined,
    403,
  );
  // Fresh-login gate protects enrollment even with an otherwise valid first factor.
  const stale = await actor("OPERATOR", "stale");
  await prisma.session.updateMany({
    where: { userId: stale.id },
    data: { createdAt: new Date(Date.now() - 300_001) },
  });
  await call("/auth/mfa/enrollment", stale.token, {}, 401);
  const expiring = await actor("OPERATOR", "expiring"),
    enroll = await call("/auth/mfa/enrollment", expiring.token, {});
  await prisma.mfaCredential.update({
    where: { userId: expiring.id },
    data: { enrollmentExpiresAt: new Date(Date.now() - 1) },
  });
  await call(
    "/auth/mfa/activate",
    expiring.token,
    { code: otp(enroll.secret) },
    401,
  );
  await call("/auth/logout", finance.token, {});
  await call("/auth/mfa", finance.token, undefined, 401);
  // Verify and logout acquire Session/User locks in different workflows. No deadlock or live token may survive.
  for (let i = 0; i < 3; i++) {
    const racer = await actor("OPERATOR", `logout-race-${i}`);
    const setup = await call("/auth/mfa/enrollment", racer.token, {});
    await call("/auth/mfa/activate", racer.token, { code: otp(setup.secret) });
    const raceCode = await nextOtp(racer.id, setup.secret);
    const responses = await Promise.all([
      fetch(base + "/auth/mfa/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${racer.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: raceCode }),
      }),
      fetch(base + "/auth/logout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${racer.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ]);
    assert.ok([200, 401].includes(responses[0]!.status));
    assert.equal(responses[1]!.status, 200);
    await call("/auth/mfa", racer.token, undefined, 401);
  }
  const audit = await prisma.auditLog.findMany({
    where: { actorId: { in: users } },
  });
  const auditText = JSON.stringify(audit);
  for (const secret of [pending.secret, financePending.secret, enroll.secret])
    assert.equal(auditText.includes(secret), false);
  const status = await call("/auth/mfa", operator.token);
  assert.equal(JSON.stringify(status).includes(pending.secret), false);
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks: [
        "fresh staff-only enrollment and encrypted one-time secret",
        "strict request schema and no-store responses",
        "same-session activation, five-minute staff gate and isolated elevation",
        "global OTP replay denial and concurrent exactly-one verification",
        "five-attempt persistent lock and no active-factor replacement",
        "DB replay/rotation/expiry/count guards",
        "independent finance role, cross-organization denial and expired enrollment",
        "logout revocation and secret-free audit/status",
      ],
      mode: "isolated HTTP/PostgreSQL; synthetic identities only; no real WeChat or authenticator enrollment",
    }),
  );
} finally {
  await app.close();
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  if (org) await prisma.organization.delete({ where: { id: org } });
  await prisma.$disconnect();
  console.log(JSON.stringify({ syntheticFixturesRemoved: true, passed }));
}

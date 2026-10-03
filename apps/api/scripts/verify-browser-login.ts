import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { PrismaClient, type UserRole } from "@prisma/client";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { decodeSecret, hotp } from "../src/auth/totp.js";
const url = process.env.BROWSER_LOGIN_TEST_DATABASE_URL;
if (!url) throw Error("Set isolated BROWSER_LOGIN_TEST_DATABASE_URL");
const target = new URL(url);
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
  DATABASE_URL: url,
  NODE_ENV: "test",
  AUTH_PROVIDER: "mock",
  PAYMENT_PROVIDER: "mock",
  STAFF_MFA_REQUIRED: "true",
  STAFF_BROWSER_LOGIN_ENABLED: "true",
  WECHAT_PAY_PREPAY_ENABLED: "false",
  WECHAT_PAY_REFUND_ENABLED: "false",
  WECHAT_PAY_RECOVERY_ENABLED: "false",
  AUTH_SESSION_PEPPER: `test-browser-${randomUUID()}`,
  DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
});
const startedAt = Date.now(),
  prisma = new PrismaClient({ datasourceUrl: url });
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
  logger: false,
  rawBody: true,
});
app.setGlobalPrefix("v1");
await app.listen(0, "127.0.0.1");
const base = `${await app.getUrl()}/v1`,
  prefix = `browser-test-${randomUUID()}`,
  crypto = new AuthCryptoService(app.get(ConfigService)),
  appId = app.get(ConfigService).get("WECHAT_MINIAPP_APP_ID");
const users: string[] = [],
  pairs: string[] = [],
  checks: string[] = [];
let org: string | undefined,
  passed = false;
async function call(path: string, token = "", body?: unknown, status = 200) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(r.status, status, `${path}; sensitive response omitted`);
  if (status === 200 && path.startsWith("/auth/browser-login"))
    assert.equal(r.headers.get("cache-control"), "no-store");
  return (await r.json()).data;
}
async function pair() {
  const p = await call("/auth/browser-login/create", "", {});
  pairs.push(p.pairCode);
  return p as {
    pairCode: string;
    browserSecret: string;
    confirmationCode: string;
    expiresAt: string;
  };
}
const proof = (p: Awaited<ReturnType<typeof pair>>) => ({
  pairCode: p.pairCode,
  browserSecret: p.browserSecret,
});
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
  const s = await call("/auth/wechat-miniapp", "", { code });
  return { id: user.id, code, token: s.accessToken as string };
}
const approve = (
  p: Awaited<ReturnType<typeof pair>>,
  token: string,
  status = 200,
) =>
  call(
    "/auth/browser-login/approve",
    token,
    { pairCode: p.pairCode, confirmationCode: p.confirmationCode },
    status,
  );
try {
  org = (await prisma.organization.create({ data: { name: prefix } })).id;
  const staff = await actor("OPERATOR", "staff"),
    customer = await actor("CUSTOMER", "customer"),
    other = await actor("FINANCE_REQUESTER", "other");
  assert.equal((await call("/auth/browser-login/config")).enabled, true);
  await call(
    "/auth/browser-login/create",
    "",
    { redirectUri: "https://evil" },
    400,
  );
  const origin = await fetch(base + "/auth/browser-login/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: "{}",
  });
  assert.equal(origin.status, 403);
  const p = await pair();
  assert.match(p.pairCode, /^[\w-]{22}$/);
  assert.match(p.browserSecret, /^[\w-]{43}$/);
  const row = await prisma.browserLoginChallenge.findUniqueOrThrow({
    where: { id: p.pairCode },
  });
  assert.equal(
    row.browserSecretHash,
    crypto.hashBrowserLogin("device", p.browserSecret),
  );
  assert.equal(JSON.stringify(row).includes(p.browserSecret), false);
  await call("/auth/browser-login/inspect", "", { pairCode: p.pairCode }, 401);
  await call(
    "/auth/browser-login/inspect",
    customer.token,
    { pairCode: p.pairCode },
    403,
  );
  const preview = await call("/auth/browser-login/inspect", staff.token, {
    pairCode: p.pairCode,
  });
  assert.equal(preview.audience, "中原到家运营后台");
  assert.equal(JSON.stringify(preview).includes(p.confirmationCode), false);
  await call("/auth/browser-login/claim", "", proof(p), 409);
  await call(
    "/auth/browser-login/poll",
    "",
    { pairCode: p.pairCode, browserSecret: "A".repeat(43) },
    401,
  );
  assert.equal(
    (await call("/auth/browser-login/poll", "", proof(p))).status,
    "PENDING",
  );
  await call("/auth/browser-login/poll", "", proof(p), 429);
  await call(
    "/auth/browser-login/approve",
    staff.token,
    {
      pairCode: p.pairCode,
      confirmationCode: p.confirmationCode,
      userId: other.id,
    },
    400,
  );
  const factor = await call("/auth/mfa/enrollment", staff.token, {});
  const otp = hotp(
    decodeSecret(factor.secret),
    BigInt(Math.floor(Date.now() / 30000)),
  );
  await call("/auth/mfa/activate", staff.token, { code: otp });
  await approve(p, staff.token);
  await approve(p, other.token, 409);
  await call(
    "/auth/browser-login/claim",
    "",
    { pairCode: p.pairCode, browserSecret: "A".repeat(43) },
    401,
  );
  const before = await prisma.session.count({ where: { userId: staff.id } });
  const claims = await Promise.all([
    fetch(base + "/auth/browser-login/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof(p)),
    }),
    fetch(base + "/auth/browser-login/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof(p)),
    }),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const browser = (await claims.find((r) => r.status === 200)!.json()).data;
  assert.notEqual(browser.accessToken, staff.token);
  assert.equal(
    await prisma.session.count({ where: { userId: staff.id } }),
    before + 1,
  );
  const bs = await prisma.session.findUniqueOrThrow({
    where: { tokenHash: crypto.hashSessionToken(browser.accessToken) },
  });
  assert.equal(bs.authChannel, "ADMIN_BROWSER");
  assert.equal(bs.mfaVerifiedUntil, null);
  assert.ok(bs.expiresAt.getTime() - bs.createdAt.getTime() <= 3600000);
  await call(
    `/admin/catalog/services?organizationId=${org}`,
    browser.accessToken,
    undefined,
    403,
  );
  await call(
    "/auth/browser-login/inspect",
    browser.accessToken,
    { pairCode: p.pairCode },
    401,
  );
  const credential = await prisma.mfaCredential.findUniqueOrThrow({
    where: { userId: staff.id },
  });
  await call("/auth/mfa/verify", browser.accessToken, {
    code: hotp(decodeSecret(factor.secret), credential.lastAcceptedStep! + 1n),
  });
  await call(
    `/admin/catalog/services?organizationId=${org}`,
    browser.accessToken,
  );
  await call("/auth/browser-login/claim", "", proof(p), 409);
  checks.push(
    "strict schema/origin/no-store, opaque browser proof, fresh staff-only approval, concurrent single session, no copied mobile token or MFA, normal MFA gate",
  );
  const fail = await pair();
  for (let i = 0; i < 5; i++)
    await call(
      "/auth/browser-login/approve",
      staff.token,
      {
        pairCode: fail.pairCode,
        confirmationCode:
          fail.confirmationCode === "000000" ? "000001" : "000000",
      },
      401,
    );
  assert.equal(
    (
      await prisma.browserLoginChallenge.findUniqueOrThrow({
        where: { id: fail.pairCode },
      })
    ).failedAttempts,
    5,
  );
  await approve(fail, staff.token, 409);
  const cancelled = await pair();
  await call("/auth/browser-login/cancel", "", proof(cancelled));
  await approve(cancelled, staff.token, 409);
  await call("/auth/browser-login/claim", "", proof(cancelled), 409);
  const expired = await pair();
  const { BrowserLoginService } = await import(
    "../dist/auth/browser-login.service.js"
  );
  await assert.rejects(
    app
      .get(BrowserLoginService)
      .poll(
        expired.pairCode,
        expired.browserSecret,
        new Date(Date.parse(expired.expiresAt) + 1),
      ),
  );
  const lost = await pair();
  await approve(lost, other.token);
  await call("/auth/logout", other.token, {});
  await call("/auth/browser-login/claim", "", proof(lost), 401);
  const stale = await actor("OPERATOR", "stale");
  await prisma.session.updateMany({
    where: { userId: stale.id },
    data: { createdAt: new Date(Date.now() - 301000) },
  });
  await call(
    "/auth/browser-login/inspect",
    stale.token,
    { pairCode: expired.pairCode },
    401,
  );
  const suspended = await actor("OPERATOR", "suspended"),
    gone = await pair();
  await approve(gone, suspended.token);
  await prisma.staffMembership.updateMany({
    where: { userId: suspended.id },
    data: { status: "SUSPENDED" },
  });
  await call("/auth/browser-login/claim", "", proof(gone), 403);
  checks.push(
    "five failures persist/cancel; browser cancel/expiry; mobile logout, stale login and membership withdrawal block claim",
  );
  await assert.rejects(
    prisma.browserLoginChallenge.update({
      where: { id: p.pairCode },
      data: {
        status: "PENDING",
        approvedUserId: null,
        approvedSessionId: null,
        approvedAt: null,
        claimedSessionId: null,
        consumedAt: null,
      },
    }),
  );
  await assert.rejects(
    prisma.browserLoginChallenge.update({
      where: { id: expired.pairCode },
      data: { expiresAt: new Date(Date.now() + 3600000) },
    }),
  );
  checks.push(
    "database immutable expiry, terminal states and provenance checks",
  );
  // Compiled miniapp JS uses wx transport/modal fixtures against this real HTTP API, not a renderer.
  const require = createRequire(import.meta.url),
    store = new Map<string, unknown>();
  let definition: any;
  const globals = globalThis as any;
  globals.getApp = () => ({ globalData: { apiBaseUrl: base } });
  globals.Page = (x: any) => {
    definition = x;
  };
  globals.wx = {
    login: ({ success }: any) => success({ code: staff.code }),
    getStorageSync: (k: string) => store.get(k),
    setStorageSync: (k: string, v: unknown) => store.set(k, v),
    removeStorageSync: (k: string) => store.delete(k),
    showModal: ({ success }: any) => success({ confirm: true, cancel: false }),
    request: (o: any) => {
      void fetch(o.url, {
        method: o.method,
        headers: o.header,
        ...(o.data === undefined ? {} : { body: JSON.stringify(o.data) }),
      })
        .then(async (r) =>
          o.success({ statusCode: r.status, data: await r.json() }),
        )
        .catch(() => o.fail({ errMsg: "fixture network error" }));
    },
  };
  require(resolve(process.cwd(), "../miniapp/pages/admin-login/index.js"));
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(x: any) {
      Object.assign(this.data, x);
    },
  };
  const mini = await pair();
  page.onPairInput({ detail: { value: mini.pairCode } });
  await page.inspect();
  assert.ok(page.data.preview);
  page.onCodeInput({ detail: { value: mini.confirmationCode } });
  await page.approve();
  assert.equal(page.data.approved, true);
  const miniSession = await call("/auth/browser-login/claim", "", proof(mini));
  assert.equal(miniSession.user.id, staff.id);
  await call("/auth/logout", miniSession.accessToken, {});
  checks.push(
    "compiled miniapp re-login/inspect/explicit modal/approval/browser claim against HTTP (no real device)",
  );
  const audit = JSON.stringify(
    await prisma.auditLog.findMany({ where: { actorId: { in: users } } }),
  );
  for (const secret of [
    p.browserSecret,
    p.confirmationCode,
    browser.accessToken,
    staff.token,
    factor.secret,
  ])
    assert.equal(audit.includes(secret), false);
  await call("/auth/logout", browser.accessToken, {});
  await call("/auth/me", browser.accessToken, undefined, 401);
  const peerKey = crypto.hashBrowserLogin(
    "rate",
    `peer-create:127.0.0.1:${Math.floor(Date.now() / 3600000)}`,
  );
  await prisma.browserLoginRateLimit.update({
    where: { key: peerKey },
    data: { count: 60 },
  });
  for (const forwarded of ["10.1.2.3", "10.9.8.7"]) {
    const r = await fetch(base + "/auth/browser-login/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": forwarded,
      },
      body: "{}",
    });
    assert.equal(r.status, 429);
  }
  assert.equal(
    (
      await prisma.browserLoginRateLimit.findUniqueOrThrow({
        where: { key: peerKey },
      })
    ).count,
    62,
  );
  checks.push(
    "persistent shared-peer limit cannot be bypassed by forged forwarded addresses",
  );
  passed = true;
  console.log(
    JSON.stringify({
      passed,
      checks,
      mode: "isolated HTTP/PostgreSQL and compiled JS fixtures; no real WeChat, authenticator or funds",
    }),
  );
} finally {
  await app.close();
  await prisma.browserLoginChallenge.deleteMany({
    where: { id: { in: pairs } },
  });
  const keys: string[] = [];
  for (let t = startedAt - 3600000; t <= Date.now() + 3600000; t += 600000) {
    const hour = Math.floor(t / 3600000),
      phone = Math.floor(t / 600000);
    for (const [purpose, subject] of [
      ["global-create", "all"],
      ["peer-create", "127.0.0.1"],
      ["peer-create", "::ffff:127.0.0.1"],
    ])
      keys.push(
        crypto.hashBrowserLogin("rate", `${purpose}:${subject}:${hour}`),
      );
    for (const id of users)
      keys.push(crypto.hashBrowserLogin("rate", `phone:${id}:${phone}`));
  }
  await prisma.browserLoginRateLimit.deleteMany({
    where: { key: { in: keys } },
  });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  if (org) await prisma.organization.delete({ where: { id: org } });
  await prisma.$disconnect();
  console.log(JSON.stringify({ syntheticFixturesRemoved: true, passed }));
}

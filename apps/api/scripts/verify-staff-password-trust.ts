import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ForbiddenException,
  ConflictException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { AuthService } from "../src/auth/auth.service.js";
import { BrowserLoginService } from "../src/auth/browser-login.service.js";
import { StaffPasswordService } from "../src/auth/staff-password.service.js";
import { TrustedDeviceService } from "../src/auth/trusted-device.service.js";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { SessionAuthGuard } from "../src/auth/session-auth.guard.js";
import { verifyStaffPassword } from "../src/auth/password-hash.js";
import type {
  AliyunSmsClient,
  SmsSubmission,
} from "../src/integrations/aliyun-sms.client.js";
import type { WechatMiniappClient } from "../src/auth/wechat-miniapp.client.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";

// Deliberately no DATABASE_URL fallback, dotenv import, shared fixture database,
// network SMS/WeChat adapter, or production bootstrap. The owner creates and
// drops this disposable database and its least-privilege role externally.
function isolatedDatabaseUrl() {
  const value = process.env.STAFF_AUTH_ACCEPTANCE_DATABASE_URL;
  if (!value) throw Error("Dedicated acceptance database is required");
  const target = new URL(value);
  const database = target.pathname.slice(1);
  if (
    !["postgresql:", "postgres:"].includes(target.protocol) ||
    !["127.0.0.1", "localhost"].includes(target.hostname) ||
    !/^zydj_staff_auth_acceptance_[0-9]{8}_[a-z0-9]+$/.test(database) ||
    target.searchParams.has("host") ||
    target.searchParams.has("hostaddr")
  )
    throw Error("Refusing a non-isolated acceptance database");
  return { value, database };
}

let activeCheck = "isolated database guard";
const checks: string[] = [];
let prisma: PrismaService | undefined;
async function check(name: string, run: () => Promise<void> | void) {
  activeCheck = name;
  await run();
  checks.push(name);
}

async function main() {
  const target = isolatedDatabaseUrl();
  // Datasource override is explicit; process.env.DATABASE_URL is never used.
  prisma = new PrismaService({ datasourceUrl: target.value });
  const database = prisma;
  await check("dedicated local database identity", async () => {
    const rows = await database.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;
    assert.ok(
      rows[0]?.database_name === target.database,
      "Wrong database target",
    );
  });
  await check("empty isolated user fixtures", async () => {
    assert.ok(
      (await database.user.count()) === 0,
      "Refusing a reused fixture database",
    );
  });
  await check("empty isolated trust fixtures", async () => {
    assert.ok(
      (await database.staffTrustedDevice.count()) === 0,
      "Refusing reused trust fixtures",
    );
  });

  activeCheck = "instantiate isolated authentication services";
  const startedAt = new Date();
  // Test aging is passed only to the services' explicit clock parameter. It
  // avoids sleeps while keeping sessions usable by authenticate's real clock.
  const loginAt = new Date(startedAt.getTime() - 180_000);
  const config = new ConfigService({
    NODE_ENV: "production",
    AUTH_PROVIDER: "wechat",
    STAFF_MFA_REQUIRED: "true",
    STAFF_BROWSER_LOGIN_ENABLED: "true",
    STAFF_PASSWORD_LOGIN_ENABLED: "true",
    STAFF_TRUSTED_DEVICE_ENABLED: "true",
    CORS_ORIGINS: "https://staff-auth-acceptance.invalid",
    AUTH_SESSION_PEPPER: `isolated-acceptance-${randomUUID()}`,
    DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    SMS_PROVIDER: "aliyun",
    SMS_SEND_ENABLED: "true",
    PHONE_VERIFICATION_SMS_ENABLED: "true",
    ALIYUN_SMS_ACCESS_KEY_ID: "isolated-placeholder-not-a-real-key",
    ALIYUN_SMS_ACCESS_KEY_SECRET: "isolated-placeholder-not-a-real-secret",
    ALIYUN_SMS_SIGN_NAME: "IsolatedAcceptance",
    ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_ISOLATED",
  });
  const crypto = new AuthCryptoService(config as never);
  const browser = new BrowserLoginService(database, crypto, config);
  const trust = new TrustedDeviceService(database, crypto, config);
  const smsCodes = new Map<string, string>();
  let smsCalls = 0;
  const fixturePhone = "13800000000";
  const sms = {
    async submitPhoneVerification(input: {
      phone: string;
      code: string;
      trackingId: string;
    }): Promise<SmsSubmission> {
      assert.ok(
        input.phone === fixturePhone,
        "Unexpected fixture SMS destination",
      );
      assert.ok(/^\d{6}$/.test(input.code), "Unexpected fixture OTP format");
      smsCalls++;
      smsCodes.set(input.trackingId, input.code);
      return {
        status: "ACCEPTED",
        requestId: `isolated-request-${smsCalls}`,
        bizId: `isolated-biz-${smsCalls}`,
      };
    },
  };
  // Neither real provider is instantiated. Any accidental WeChat method call
  // fails locally; the real AuthService is used only for stored-session checks.
  const wechat = {
    async exchangeCode(): Promise<never> {
      throw Error("Network WeChat is forbidden in acceptance");
    },
    async exchangePhoneCode(): Promise<never> {
      throw Error("Network WeChat is forbidden in acceptance");
    },
  };
  const password = new StaffPasswordService(
    database,
    crypto,
    config,
    sms as AliyunSmsClient,
    browser,
  );
  const auth = new AuthService(
    database,
    crypto,
    wechat as unknown as WechatMiniappClient,
    config as never,
    trust,
  );
  const access = new AccessControlService(config);
  const guard = new SessionAuthGuard(auth, config);
  const firstPassword = `isolated-first-${randomUUID()}`;
  const secondPassword = `isolated-second-${randomUUID()}`;
  const agent = "Isolated acceptance browser/1.0";
  activeCheck = "create isolated organization fixture";
  const organization = await database.organization.create({
    data: { name: "Isolated staff auth acceptance" },
  });
  activeCheck = "create isolated staff fixture";
  const user = await database.user.create({
    data: {
      role: "ADMIN",
      displayName: "Isolated fixture administrator",
      status: "ACTIVE",
      phoneEncrypted: crypto.encrypt(fixturePhone),
      phoneVerifiedAt: loginAt,
      // ADMIN ensures finance/IAM denial below tests the assurance boundary,
      // not merely an absent role permission. This is never a production user.
      memberships: {
        create: {
          organizationId: organization.id,
          role: "ADMIN",
          status: "ACTIVE",
        },
      },
      mfaCredential: {
        create: {
          secretEncrypted: crypto.encrypt("ISOLATED-UNUSED-TOTP-SECRET"),
          enabledAt: new Date(startedAt.getTime() - 86_400_000),
          lastAcceptedStep: 0n,
        },
      },
    },
  });
  async function browserSession(freshMfa = false, createdAt = new Date()) {
    const token = crypto.createSessionToken();
    const row = await database.session.create({
      data: {
        userId: user.id,
        tokenHash: crypto.hashSessionToken(token),
        authChannel: "ADMIN_BROWSER",
        authProvider: "wechat",
        createdAt,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedUntil: freshMfa ? new Date(Date.now() + 300_000) : null,
      },
    });
    return { token, row, principal: await auth.authenticate(token) };
  }
  // An explicit fixture TOTP-proved session provisions the password/device.
  // No real person is enrolled or any dynamic code disclosed.
  activeCheck = "create isolated proved browser session";
  const proof = await browserSession(true, loginAt);
  await check(
    "password provider remains restricted to the browser channel",
    async () => {
      const before = await database.session.count({
        where: { userId: user.id },
      });
      await assert.rejects(
        database.session.create({
          data: {
            userId: user.id,
            tokenHash: crypto.hashSessionToken(crypto.createSessionToken()),
            authChannel: "WECHAT_MINIAPP",
            authProvider: "staff-password",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        }),
      );
      assert.ok(
        (await database.session.count({ where: { userId: user.id } })) ===
          before,
        "Invalid provider channel persisted",
      );
    },
  );
  function codeFor(id: string) {
    const code = smsCodes.get(id);
    assert.ok(code, "Missing in-memory fixture SMS acceptance");
    return code;
  }
  async function issuePasswordChallenge(
    secret: string,
    now: Date,
    account = fixturePhone,
  ) {
    return password.login(
      { account, password: secret },
      "isolated-socket-peer",
      now,
    );
  }
  async function requestGuard(token: string, method: string) {
    const request = {
      headers: { authorization: `Bearer ${token}` },
      method,
      routeOptions: {
        url: "/v1/admin/organizations/:organizationId/technicians/applications",
      },
      url: "/v1/admin/organizations/isolated/technicians/applications",
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    return guard.canActivate(context);
  }
  async function assertReadOnlyAssurance(
    principal: AuthPrincipal,
    token: string,
  ) {
    assert.ok(
      principal.mfaVerifiedUntil === null,
      "Login assurance must not become TOTP",
    );
    assert.ok(
      access.hasPermission(principal, "technicians.manage", organization.id),
      "Management read must be available",
    );
    assert.ok(
      access.hasPermission(principal, "audit.read", organization.id),
      "Audit read must be available",
    );
    assert.ok(
      !access.hasPermission(principal, "finance.request", organization.id),
      "Finance request must require TOTP",
    );
    assert.ok(
      !access.hasPermission(principal, "finance.approve", organization.id),
      "Finance approval must require TOTP",
    );
    assert.ok(
      !access.hasPermission(principal, "iam.manage", organization.id),
      "IAM must require TOTP",
    );
    assert.ok(
      await requestGuard(token, "GET"),
      "Admin GET guard must permit authenticated reads",
    );
    await assert.rejects(
      requestGuard(token, "POST"),
      (error: unknown) => error instanceof ForbiddenException,
    );
  }

  await check(
    "password provisioning and non-plaintext persistence",
    async () => {
      assert.ok(
        password.configuration().enabled && password.configuration().smsEnabled,
        "Acceptance feature configuration unavailable",
      );
      await password.setPassword(
        proof.principal,
        firstPassword,
        loginAt,
        " AdMiN ",
      );
      const credential =
        await database.staffPasswordCredential.findUniqueOrThrow({
          where: { userId: user.id },
        });
      assert.ok(
        credential.passwordHash.startsWith("scrypt.v1."),
        "Expected scrypt credential",
      );
      assert.ok(
        !credential.passwordHash.includes(firstPassword),
        "Password leaked to credential storage",
      );
      assert.ok(
        await verifyStaffPassword(firstPassword, credential.passwordHash),
        "Real password hash verification failed",
      );
      assert.ok(
        credential.version === 1,
        "Initial password credential version differs",
      );
      assert.ok(
        credential.loginAlias === "admin",
        "Chosen alias was not normalized",
      );
      const status = await password.status(proof.principal);
      assert.ok(
        status.loginAlias === "admin" && status.maskedAccount === "138****0000",
        "Alias status did not retain masked phone privacy",
      );
    },
  );

  const firstChallenge = await issuePasswordChallenge(firstPassword, loginAt);
  await check("SMS substitute and hashed challenge persistence", async () => {
    const row = await database.staffPasswordLoginChallenge.findUniqueOrThrow({
      where: { id: firstChallenge.challengeId },
    });
    assert.ok(
      row.status === "ACCEPTED",
      "Provider substitute acceptance missing",
    );
    assert.ok(
      row.secretHash ===
        crypto.hashBrowserLogin(
          "staff-password:secret",
          firstChallenge.challengeSecret,
        ),
      "Challenge secret not safely hashed",
    );
    assert.ok(
      row.codeHash ===
        crypto.hashBrowserLogin(
          "staff-password:code",
          `${row.id}:${codeFor(row.id)}`,
        ),
      "Challenge OTP not safely hashed",
    );
    assert.ok(smsCalls === 1, "Unexpected SMS substitute invocation count");
  });

  const sessionsBefore = await database.session.count({
    where: { userId: user.id },
  });
  const input = {
    challengeId: firstChallenge.challengeId,
    challengeSecret: firstChallenge.challengeSecret,
    code: codeFor(firstChallenge.challengeId),
  };
  const confirmations = await Promise.allSettled([
    password.confirm(input, "isolated-socket-peer", loginAt),
    password.confirm(input, "isolated-socket-peer", loginAt),
  ]);
  const successful = confirmations.find(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<StaffPasswordService["confirm"]>>
    > => result.status === "fulfilled",
  );
  await check(
    "concurrent SMS confirmation yields exactly one session",
    async () => {
      assert.ok(
        confirmations.filter((result) => result.status === "fulfilled")
          .length === 1,
        "Concurrent challenge consumption was not singular",
      );
      assert.ok(
        confirmations.filter((result) => result.status === "rejected")
          .length === 1,
        "Concurrent loser was not rejected",
      );
      assert.ok(
        (await database.session.count({ where: { userId: user.id } })) ===
          sessionsBefore + 1,
        "Unexpected session issuance count",
      );
      const row = await database.staffPasswordLoginChallenge.findUniqueOrThrow({
        where: { id: input.challengeId },
      });
      assert.ok(
        row.status === "CONSUMED" && row.consumedAt !== null,
        "Challenge was not durably consumed",
      );
      await assert.rejects(
        password.confirm(input, "isolated-socket-peer", loginAt),
        (error: unknown) => error instanceof UnauthorizedException,
      );
    },
  );
  assert.ok(successful, "Successful concurrent confirmation missing");
  const passwordSession = successful.value;
  await check(
    "password SMS login grants reads but not TOTP-sensitive operations",
    async () => {
      const principal = await auth.authenticate(passwordSession.accessToken);
      assert.ok(
        principal.staffVerificationMethod === "PASSWORD_SMS",
        "Password login assurance missing",
      );
      await assertReadOnlyAssurance(principal, passwordSession.accessToken);
      await assert.rejects(
        trust.register(principal, "Forbidden without TOTP", agent),
        (error: unknown) => error instanceof UnauthorizedException,
      );
    },
  );

  const secondChallenge = await issuePasswordChallenge(
    firstPassword,
    new Date(loginAt.getTime() + 60_001),
  );
  await check("expired SMS challenge cannot issue a session", async () => {
    const before = await database.session.count({ where: { userId: user.id } });
    await assert.rejects(
      password.confirm(
        {
          challengeId: secondChallenge.challengeId,
          challengeSecret: secondChallenge.challengeSecret,
          code: codeFor(secondChallenge.challengeId),
        },
        "isolated-socket-peer",
        new Date(secondChallenge.expiresAt),
      ),
      (error: unknown) => error instanceof UnauthorizedException,
    );
    assert.ok(
      (await database.session.count({ where: { userId: user.id } })) === before,
      "Expired challenge issued a session",
    );
  });

  const registeredAt = new Date();
  const remembered = await trust.register(
    await auth.authenticate(proof.token),
    "Isolated remembered browser",
    agent,
    registeredAt,
  );
  const fresh = await browserSession();
  await check(
    "trust registration requires actual proof and fixed seven-day expiry",
    async () => {
      const row = await database.staffTrustedDevice.findUniqueOrThrow({
        where: { id: remembered.device.id },
      });
      assert.ok(
        row.tokenHash ===
          crypto.hashBrowserLogin("trusted-device-token", remembered.token),
        "Trusted capability not safely hashed",
      );
      assert.ok(
        row.expiresAt.getTime() - row.createdAt.getTime() === 7 * 86_400_000,
        "Trust lifetime is not fixed seven days",
      );
      const principal = await auth.authenticate(fresh.token);
      assert.ok(
        principal.staffVerifiedUntil === null,
        "WeChat first factor should not carry device/TOTP proof",
      );
      assert.ok(
        !access.hasPermission(principal, "technicians.manage", organization.id),
        "Unverified first factor reached management reads",
      );
    },
  );
  await check(
    "remembered device acceptance preserves separate login assurance",
    async () => {
      const accepted = await trust.accept(
        fresh.principal,
        remembered.token,
        agent,
      );
      assert.ok(
        accepted.trusted,
        "Valid device did not accept a fresh first factor",
      );
      const principal = await auth.authenticate(fresh.token);
      assert.ok(
        principal.staffVerificationMethod === "TRUSTED_DEVICE",
        "Authenticate did not validate stored device assurance",
      );
      await assertReadOnlyAssurance(principal, fresh.token);
      const row = await database.session.findUniqueOrThrow({
        where: { id: fresh.row.id },
      });
      assert.ok(
        row.mfaVerifiedUntil === null,
        "Device acceptance minted a TOTP grant",
      );
    },
  );
  await check(
    "repeated acceptance never extends the trusted device deadline",
    async () => {
      const expiryBefore = await database.staffTrustedDevice.findUniqueOrThrow({
        where: { id: remembered.device.id },
      });
      assert.ok(
        (
          await trust.accept(
            fresh.principal,
            remembered.token,
            agent,
            new Date(Date.now() + 60_000),
          )
        ).trusted,
        "Repeat acceptance failed before expiry",
      );
      const expiryAfter = await database.staffTrustedDevice.findUniqueOrThrow({
        where: { id: remembered.device.id },
      });
      assert.ok(
        expiryBefore.expiresAt.getTime() === expiryAfter.expiresAt.getTime(),
        "Device expiry slid on reuse",
      );
      assert.ok(
        (await auth.authenticate(fresh.token)).staffVerificationMethod ===
          "TRUSTED_DEVICE",
        "Repeat acceptance invalidated valid assurance",
      );
    },
  );
  await check(
    "revocation immediately removes existing remembered-device assurance",
    async () => {
      await trust.revoke(
        await auth.authenticate(proof.token),
        remembered.device.id,
      );
      const principal = await auth.authenticate(fresh.token);
      assert.ok(
        principal.staffVerifiedUntil === null &&
          principal.staffVerificationMethod === null,
        "Revoked device retained authenticated login assurance",
      );
      assert.ok(
        !access.hasPermission(principal, "technicians.manage", organization.id),
        "Revoked device retained management access",
      );
      const row = await database.session.findUniqueOrThrow({
        where: { id: fresh.row.id },
      });
      assert.ok(
        row.trustedDeviceId === null && row.staffVerifiedUntil === null,
        "Linked session assurance was not durably cleared",
      );
      assert.ok(
        !(await trust.accept(fresh.principal, remembered.token, agent)).trusted,
        "Revoked cookie was accepted again",
      );
    },
  );

  const secondRemembered = await trust.register(
    await auth.authenticate(proof.token),
    "Isolated second browser",
    agent,
  );
  const secondFresh = await browserSession();
  assert.ok(
    (await trust.accept(secondFresh.principal, secondRemembered.token, agent))
      .trusted,
    "Second fixture device acceptance failed",
  );
  await check(
    "password change revokes old sessions, devices and pending challenges",
    async () => {
      await password.setPassword(
        await auth.authenticate(proof.token),
        secondPassword,
      );
      const credential =
        await database.staffPasswordCredential.findUniqueOrThrow({
          where: { userId: user.id },
        });
      assert.ok(
        credential.version === 2 &&
          (await verifyStaffPassword(
            secondPassword,
            credential.passwordHash,
          )) &&
          credential.loginAlias === "admin",
        "Password version/hash did not rotate",
      );
      assert.ok(
        !(await verifyStaffPassword(firstPassword, credential.passwordHash)),
        "Old password still matches current credential",
      );
      await assert.rejects(
        auth.authenticate(passwordSession.accessToken),
        (error: unknown) => error instanceof UnauthorizedException,
      );
      await assert.rejects(
        auth.authenticate(secondFresh.token),
        (error: unknown) => error instanceof UnauthorizedException,
      );
      const device = await database.staffTrustedDevice.findUniqueOrThrow({
        where: { id: secondRemembered.device.id },
      });
      assert.ok(
        device.revokedAt !== null,
        "Password change retained trusted devices",
      );
      const challenge =
        await database.staffPasswordLoginChallenge.findUniqueOrThrow({
          where: { id: secondChallenge.challengeId },
        });
      assert.ok(
        challenge.status === "REJECTED" && challenge.consumedAt !== null,
        "Password change retained pending challenge",
      );
      await assert.rejects(
        password.confirm(
          {
            challengeId: secondChallenge.challengeId,
            challengeSecret: secondChallenge.challengeSecret,
            code: codeFor(secondChallenge.challengeId),
          },
          "isolated-socket-peer",
        ),
        (error: unknown) => error instanceof UnauthorizedException,
      );
      assert.ok(
        (await auth.authenticate(proof.token)).staffPasswordVersion === 2,
        "Proved current session was not retained at new version",
      );
    },
  );
  await check(
    "alias and rotated password complete the existing persisted staff login",
    async () => {
      const challenge = await issuePasswordChallenge(
        secondPassword,
        new Date(loginAt.getTime() + 120_002),
        " AdMiN ",
      );
      const session = await password.confirm(
        {
          challengeId: challenge.challengeId,
          challengeSecret: challenge.challengeSecret,
          code: codeFor(challenge.challengeId),
        },
        "isolated-socket-peer",
        new Date(loginAt.getTime() + 120_002),
      );
      const principal = await auth.authenticate(session.accessToken);
      assert.ok(
        principal.staffPasswordVersion === 2 &&
          principal.staffVerificationMethod === "PASSWORD_SMS",
        "New credential did not establish login assurance",
      );
      await assertReadOnlyAssurance(principal, session.accessToken);
    },
  );

  const expiring = await trust.register(
    await auth.authenticate(proof.token),
    "Isolated expiring device",
    agent,
  );
  const expiringSession = await browserSession();
  assert.ok(
    (await trust.accept(expiringSession.principal, expiring.token, agent))
      .trusted,
    "Expiring fixture initial acceptance failed",
  );
  await check(
    "authenticate rechecks trust expiry on every request",
    async () => {
      await database.staffTrustedDevice.update({
        where: { id: expiring.device.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      const principal = await auth.authenticate(expiringSession.token);
      assert.ok(
        principal.staffVerifiedUntil === null,
        "Expired device retained login assurance",
      );
      assert.ok(
        !access.hasPermission(principal, "technicians.manage", organization.id),
        "Expired device retained management access",
      );
    },
  );

  await check(
    "audit and summary results do not disclose authentication material",
    async () => {
      const rows = await database.auditLog.findMany({
        where: { actorId: user.id },
        select: { action: true, metadata: true },
      });
      const serialized = JSON.stringify(rows);
      for (const secret of [
        fixturePhone,
        firstPassword,
        secondPassword,
        remembered.token,
        secondRemembered.token,
        expiring.token,
        firstChallenge.challengeSecret,
      ])
        assert.ok(
          !serialized.includes(secret),
          "Authentication material leaked to audit",
        );
      const summaries = await trust.list(await auth.authenticate(proof.token));
      const summaryJson = JSON.stringify(summaries);
      assert.ok(
        !summaryJson.includes("tokenHash") &&
          !summaryJson.includes("phoneHash") &&
          !summaryJson.includes("mfaEnabledAtSnapshot"),
        "Sensitive device snapshot leaked to summary",
      );
      for (const secret of [
        remembered.token,
        secondRemembered.token,
        expiring.token,
      ])
        assert.ok(
          !summaryJson.includes(secret),
          "Device capability leaked to summary",
        );
    },
  );

  // Additional records exist only in the guarded, initially empty disposable
  // database. They exercise migration NULL compatibility and true unique-index
  // races, never production bootstrap or user/role creation through login.
  activeCheck = "create isolated alias constraint fixtures";
  const credentialSnapshot =
    await database.staffPasswordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
  const aliasFixtures = await Promise.all(
    ["13900000001", "13900000002"].map(async (phone) => {
      const fixture = await database.user.create({
        data: {
          role: "OPERATOR",
          displayName: "Isolated alias constraint fixture",
          status: "ACTIVE",
          phoneEncrypted: crypto.encrypt(phone),
          phoneVerifiedAt: new Date(),
          memberships: {
            create: {
              organizationId: organization.id,
              role: "OPERATOR",
              status: "ACTIVE",
            },
          },
        },
      });
      const credential = await database.staffPasswordCredential.create({
        data: {
          userId: fixture.id,
          phoneHash: crypto.hashPhoneVerification("phone", phone),
          passwordHash: credentialSnapshot.passwordHash,
        },
      });
      return { user: fixture, credential };
    }),
  );
  await check(
    "migration preserves multiple phone-only credentials without alias backfill",
    async () => {
      assert.ok(
        aliasFixtures.every(
          (fixture) => fixture.credential.loginAlias === null,
        ),
        "Nullable legacy aliases were backfilled",
      );
    },
  );
  await check(
    "database alias normalization constraint rejects direct noncanonical writes",
    async () => {
      await assert.rejects(
        database.staffPasswordCredential.update({
          where: { userId: aliasFixtures[0]!.user.id },
          data: { loginAlias: "ADMIN" },
        }),
      );
      await assert.rejects(
        database.staffPasswordCredential.update({
          where: { userId: aliasFixtures[0]!.user.id },
          data: { loginAlias: "12ab" },
        }),
      );
      assert.ok(
        (
          await database.staffPasswordCredential.findUniqueOrThrow({
            where: { userId: aliasFixtures[0]!.user.id },
          })
        ).loginAlias === null,
        "Invalid alias persisted",
      );
    },
  );
  await check(
    "concurrent alias writes are serialized by the real unique index",
    async () => {
      const writes = await Promise.allSettled(
        aliasFixtures.map((fixture) =>
          database.staffPasswordCredential.update({
            where: { userId: fixture.user.id },
            data: { loginAlias: "isolated-shared" },
          }),
        ),
      );
      assert.ok(
        writes.filter((result) => result.status === "fulfilled").length === 1,
        "Concurrent alias uniqueness was not enforced",
      );
      assert.ok(
        writes.filter((result) => result.status === "rejected").length === 1,
        "Concurrent alias collision was not rejected",
      );
    },
  );
  await check(
    "existing alias collision returns generic error and rolls back self credential changes",
    async () => {
      const actor = aliasFixtures[0]!;
      const token = crypto.createSessionToken();
      const row = await database.session.create({
        data: {
          userId: actor.user.id,
          tokenHash: crypto.hashSessionToken(token),
          authChannel: "ADMIN_BROWSER",
          authProvider: "wechat",
          expiresAt: new Date(Date.now() + 3_600_000),
          mfaVerifiedUntil: new Date(Date.now() + 300_000),
        },
      });
      const before = await database.staffPasswordCredential.findUniqueOrThrow({
        where: { userId: actor.user.id },
      });
      const beforeUsers = await database.user.count();
      const beforeMemberships = await database.staffMembership.count();
      await assert.rejects(
        password.setPassword(
          await auth.authenticate(token),
          secondPassword,
          new Date(),
          "admin",
        ),
        (error: unknown) =>
          error instanceof ConflictException &&
          error.message === "登录名不可用",
      );
      const after = await database.staffPasswordCredential.findUniqueOrThrow({
        where: { userId: actor.user.id },
      });
      assert.ok(
        after.version === before.version &&
          after.passwordHash === before.passwordHash &&
          after.loginAlias === before.loginAlias,
        "Rejected collision changed the actor credential",
      );
      assert.ok(
        (
          await database.staffPasswordCredential.findUniqueOrThrow({
            where: { userId: user.id },
          })
        ).loginAlias === "admin",
        "Rejected collision changed the existing alias owner",
      );
      assert.ok(
        (await database.session.findUniqueOrThrow({ where: { id: row.id } }))
          .revokedAt === null,
        "Rejected collision mutated the active actor session",
      );
      assert.ok(
        (await database.user.count()) === beforeUsers &&
          (await database.staffMembership.count()) === beforeMemberships,
        "Password configuration created identities or permissions",
      );
    },
  );
  // Only check names/counts leave this process; no record payloads, identity,
  // credentials, OTPs, hashes, tokens, or connection URL are printed.
  console.log(JSON.stringify({ passedChecks: checks.length, checks }));
}

try {
  await main();
} catch (error) {
  // Prisma or assertion errors can contain connection/query values. Do not
  // dump the original exception or stack in an authentication acceptance run.
  const failure = error as { name?: string; code?: string; errorCode?: string };
  const code = failure.code ?? failure.errorCode;
  const category = /^P[0-9]{4}$/.test(code ?? "")
    ? code
    : failure.name === "AssertionError"
      ? "ASSERTION"
      : failure.name === "PrismaClientValidationError"
        ? "PRISMA_VALIDATION"
        : failure.name === "TypeError"
          ? "TYPE"
          : failure.name === "UnauthorizedException"
            ? "UNAUTHORIZED"
            : failure.name === "ForbiddenException"
              ? "FORBIDDEN"
              : "UNKNOWN";
  console.error(
    `FAILED: ${activeCheck}; category=${category}; diagnostic values intentionally withheld.`,
  );
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}

import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaClient, type UserRole } from "@prisma/client";
import type { AppEnv } from "../src/config/env.js";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { AuthService } from "../src/auth/auth.service.js";
import { CustomerLoginService } from "../src/auth/customer-login.service.js";
import { CustomerPhoneIdentityService } from "../src/auth/customer-phone-identity.service.js";
import type { WechatIdentityResult } from "../src/auth/wechat-miniapp.client.js";

// No fallback to DATABASE_URL, production credentials, remote host, or existing DB.
const databaseUrl = process.env.CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL;
if (!databaseUrl) throw new Error("Set the isolated CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL; DATABASE_URL is never accepted");
const target = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || !/^\/zydj_customer_auth_acceptance_[a-zA-Z0-9_]+$/.test(target.pathname) || target.searchParams.has("schema") && target.searchParams.get("schema") !== "public")
  throw new Error("Refusing anything except a dedicated local customer-auth acceptance database");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
let stage = "empty-database-preflight";
const checks: string[] = [];
const add = (name: string) => { checks.push(name); stage = name; };
const allPhones = new Set<string>();
const deliveredCodes = new Set<string>();

try {
  await prisma.$connect();
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  assert.ok(tables.some((row) => row.tablename === "CustomerSmsLoginChallenge"), "Apply migrations to the isolated DB first");
  for (const { tablename } of tables) {
    assert.match(tablename, /^[A-Za-z][A-Za-z0-9_]*$/);
    const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT EXISTS (SELECT 1 FROM "${tablename}") AS present`);
    assert.equal(rows[0]?.present, false, "Acceptance database must contain no application rows");
  }
  add("empty database and local-only destination verified");

  const configuration = {
    NODE_ENV: "test", AUTH_PROVIDER: "wechat", WECHAT_MINIAPP_APP_ID: "wx-customer-acceptance", WECHAT_MINIAPP_SECRET: "test-placeholder-never-used-for-network",
    AUTH_SESSION_TTL_SECONDS: 600, AUTH_SESSION_PEPPER: `customer-auth-test-only-${randomUUID()}`,
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 17).toString("base64"),
    CUSTOMER_SMS_LOGIN_ENABLED: "true", PHONE_VERIFICATION_SMS_ENABLED: "true", SMS_PROVIDER: "aliyun", SMS_SEND_ENABLED: "true",
    ALIYUN_SMS_ACCESS_KEY_ID: "unit-only-placeholder", ALIYUN_SMS_ACCESS_KEY_SECRET: "unit-only-no-provider-call", ALIYUN_SMS_SIGN_NAME: "测试", ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_TEST",
  };
  const config = new ConfigService(configuration) as ConfigService<AppEnv, true>;
  const crypto = new AuthCryptoService(config);
  const phones = new CustomerPhoneIdentityService(prisma as never, crypto);
  const identities = new Map<string, WechatIdentityResult>();
  const phoneCodes = new Map<string, string>();
  const smsInbox = new Map<string, { phone: string; code: string }>();
  const wechat = {
    exchangeCode: async (code: string) => { const identity = identities.get(code); assert.ok(identity, "Unknown fixture authorization code"); return identity; },
    exchangePhoneCode: async (code: string) => { const phoneNumber = phoneCodes.get(code); assert.ok(phoneNumber, "Unknown fixture phone code"); return { phoneNumber }; },
  };
  // This stub is the only SMS adapter. No AliyunSmsClient is instantiated.
  const sms = { submitPhoneVerification: async (input: { phone: string; code: string; trackingId: string }) => {
    smsInbox.set(input.trackingId, { phone: input.phone, code: input.code }); deliveredCodes.add(input.code);
    return { status: "ACCEPTED" as const, requestId: randomUUID(), bizId: randomUUID() };
  } };
  const login = new CustomerLoginService(prisma as never, crypto, wechat as never, config, phones, sms as never);
  const auth = new AuthService(prisma as never, crypto, wechat as never, config, undefined, phones);
  const organization = await prisma.organization.create({ data: { name: "Customer auth isolated acceptance only" } });
  const service = await prisma.service.create({ data: { organizationId: organization.id, slug: `acceptance-${randomUUID()}`, name: "Acceptance service", category: "MASSAGE", subtitle: "Test only", description: "No actual booking", durationMinutes: 60, priceFen: 21800n, steps: [], boundaries: {} } });
  const ip = "127.0.0.1";

  const issueCodes = (phone: string, identity: WechatIdentityResult) => {
    allPhones.add(phone); const code = randomUUID(), phoneCode = randomUUID(); identities.set(code, identity); phoneCodes.set(phoneCode, phone);
    return { code, phoneCode, agreementsAccepted: true as const };
  };
  const wxLogin = (phone: string, openId: string, unionId?: string) => login.wechatPhone(issueCodes(phone, { openId, ...(unionId ? { unionId } : {}) }));
  const smsRequest = async (phone: string, address = ip) => {
    allPhones.add(phone); const response = await login.requestSms({ phone, agreementsAccepted: true }, address);
    return { response, input: { phone, code: smsInbox.get(response.challengeId)!.code, challengeId: response.challengeId, agreementsAccepted: true as const } };
  };
  const user = async (name: string, phone?: string, openId?: string, role: UserRole = "CUSTOMER") => {
    if (phone) allPhones.add(phone);
    return prisma.user.create({ data: {
      role, displayName: name,
      ...(phone ? { phoneEncrypted: crypto.encrypt(phone), phoneVerifiedAt: new Date() } : {}),
      ...(role !== "CUSTOMER" ? { memberships: { create: { organizationId: organization.id, role } } } : {}),
      ...(openId ? { identities: { create: { provider: "WECHAT_MINIAPP", subjectHash: crypto.hashIdentity(configuration.WECHAT_MINIAPP_APP_ID, openId), subjectEncrypted: crypto.encrypt(openId) } } } : {}),
    } });
  };
  const assets = async (customerId: string) => {
    const account = await prisma.storedValueAccount.create({ data: { customerId, organizationId: organization.id, balanceFen: 8800n } });
    await prisma.storedValueTransaction.create({ data: { accountId: account.id, type: "ACCEPTANCE", changeFen: 8800n, balanceAfterFen: 8800n, description: "Preserve this test ledger row" } });
    await prisma.customerCoupon.create({ data: { organizationId: organization.id, customerId, title: "Test legacy coupon", amountFen: 1000n, minimumSpendFen: 19800n, expiresAt: new Date(Date.now() + 86400000) } });
    await prisma.order.create({ data: {
      orderNo: `ACCEPTANCE-${randomUUID()}`, organizationId: organization.id, customerId, status: "CANCELLED",
      appointmentStart: new Date(Date.now() + 3600000), appointmentEnd: new Date(Date.now() + 7200000),
      serviceAmountFen: 21800n, travelFeeFen: 0n, payableFen: 21800n, addressEncrypted: crypto.encrypt("Isolated fixture only"), policyVersion: "test-v1", idempotencyKey: randomUUID(), requestFingerprint: randomUUID(),
      items: { create: { serviceId: service.id, serviceName: service.name, durationMinutes: 60, unitPriceFen: 21800n } },
    } });
  };
  const snapshotAssets = async (customerId: string) => {
    const rows = await Promise.all([
      prisma.storedValueAccount.findMany({ where: { customerId }, include: { transactions: true }, orderBy: { id: "asc" } }),
      prisma.customerCoupon.findMany({ where: { customerId }, orderBy: { id: "asc" } }),
      prisma.order.findMany({ where: { customerId }, include: { items: true }, orderBy: { id: "asc" } }),
    ]);
    return JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  };

  stage = "legacy assets preservation";
  const legacyPhone = "13800138001", legacyOpenId = "acceptance-legacy-openid";
  const legacy = await user("Legacy customer", legacyPhone, legacyOpenId);
  await assets(legacy.id); const before = await snapshotAssets(legacy.id);
  const wxLegacy = await wxLogin(legacyPhone, legacyOpenId);
  assert.equal(wxLegacy.user.id, legacy.id);
  const historicalUnion = "acceptance-legacy-union";
  const historicalUnionHash = crypto.hashIdentity("unionid", historicalUnion);
  await prisma.externalIdentity.update({ where: { provider_subjectHash: { provider: "WECHAT_MINIAPP", subjectHash: crypto.hashIdentity(configuration.WECHAT_MINIAPP_APP_ID, legacyOpenId) } }, data: { unionIdHash: historicalUnionHash, unionIdEncrypted: crypto.encrypt(historicalUnion) } });
  await prisma.wechatUnionIdentity.create({ data: { unionIdHash: historicalUnionHash, unionIdEncrypted: crypto.encrypt(historicalUnion), userId: legacy.id } });
  assert.equal((await wxLogin(legacyPhone, legacyOpenId)).user.id, legacy.id);
  assert.equal((await prisma.wechatUnionIdentity.findUniqueOrThrow({ where: { userId: legacy.id } })).unionIdHash, historicalUnionHash);
  const smsLegacy = await smsRequest(legacyPhone);
  const smsLegacySession = await login.confirmSms(smsLegacy.input, ip);
  assert.equal(smsLegacySession.user.id, legacy.id); assert.equal(await snapshotAssets(legacy.id), before);
  add("legacy order wallet coupon and ledger remain byte-for-byte owned by original user");
  add("a later same-OpenID exchange missing UnionID preserves its historical cross-channel owner");

  stage = "new phone concurrent canonical creation";
  const freshPhone = "13800138002";
  stage = "concurrent canonical: six WeChat transactions";
  const concurrentResults = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => wxLogin(freshPhone, `new-openid-${index}`)));
  stage = "concurrent canonical: returned user identities";
  const firstConcurrentSuccess = concurrentResults.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof wxLogin>>> | undefined;
  assert.ok(firstConcurrentSuccess, "At least one concurrent authentication must succeed");
  const canonical = firstConcurrentSuccess.value.user.id;
  const concurrent: Array<Awaited<ReturnType<typeof wxLogin>>> = [];
  for (let index = 0; index < concurrentResults.length; index++) {
    const result = concurrentResults[index]!;
    if (result.status === "fulfilled") {
      assert.equal(result.value.user.id, canonical); concurrent[index] = result.value;
    } else {
      // Slow isolated SSH round trips may legitimately reach bounded overload.
      // Only the documented LOGIN_BUSY response is acceptable, never a conflict,
      // uniqueness error, assertion, arbitrary 503, or silent dropped identity.
      assert.equal(result.reason?.getResponse?.().code, "LOGIN_BUSY");
    }
  }
  for (let index = 0; index < concurrentResults.length; index++) {
    if (concurrentResults[index]!.status === "fulfilled") continue;
    stage = `concurrent canonical: fresh authorization bounded-busy retry ${index}`;
    // A real user repeats the button flow with NEW wx.login/getPhoneNumber codes.
    // No backend retry reuses the spent original provider credentials.
    concurrent[index] = await wxLogin(freshPhone, `new-openid-${index}`);
    assert.equal(concurrent[index]!.user.id, canonical);
  }
  stage = "concurrent canonical: SMS challenge request";
  const freshSms = await smsRequest(freshPhone);
  stage = "concurrent canonical: SMS confirmation user identity";
  assert.equal((await login.confirmSms(freshSms.input, ip)).user.id, canonical);
  stage = "concurrent canonical: unique stored phone owner";
  const usersForPhone = (await prisma.user.findMany({ where: { phoneVerifiedAt: { not: null }, phoneEncrypted: { not: null } } })).filter((row) => crypto.decrypt(row.phoneEncrypted!) === freshPhone);
  assert.equal(usersForPhone.length, 1);
  for (let index = 0; index < concurrent.length; index++) {
    stage = `concurrent canonical: authorization provenance ${index}`;
    const principal = await auth.authenticate(concurrent[index]!.accessToken);
    assert.ok(principal.wechatIdentityId);
    stage = `concurrent canonical: stored authorizing identity ${index}`;
    const actual = await prisma.externalIdentity.findUniqueOrThrow({ where: { id: principal.wechatIdentityId! } });
    stage = `concurrent canonical: exact authorizing identity assertion ${index}`;
    assert.equal(actual.userId, canonical); assert.equal(crypto.decrypt(actual.subjectEncrypted), `new-openid-${index}`);
  }
  add("concurrent WeChat uses one canonical user; bounded LOGIN_BUSY retries with fresh codes retain exact OpenID and SMS owner");

  stage = "SMS-first concurrent OTP replay";
  const smsFirstPhone = "13800138003", smsFirst = await smsRequest(smsFirstPhone);
  const simultaneous = await Promise.allSettled([login.confirmSms(smsFirst.input, ip), login.confirmSms(smsFirst.input, ip)]);
  assert.equal(simultaneous.filter((result) => result.status === "fulfilled").length, 1);
  const first = simultaneous.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof login.confirmSms>>>;
  const smsFirstWx = await wxLogin(smsFirstPhone, "sms-first-openid"); assert.equal(smsFirstWx.user.id, first.value.user.id);
  add("SMS-first registration shares one user with WeChat and concurrent OTP replay creates only one session");

  stage = "empty legacy shell safe conflict";
  const shellOpenId = "empty-shell-openid", shell = await user("Empty WeChat shell", undefined, shellOpenId);
  const shellCode = randomUUID(); identities.set(shellCode, { openId: shellOpenId });
  const oldShellSession = await auth.loginWithWechat(shellCode);
  await assert.rejects(wxLogin(legacyPhone, shellOpenId), (error: any) => error?.getResponse?.().code === "ACCOUNT_LINK_CONFLICT");
  assert.equal((await auth.authenticate(oldShellSession.accessToken)).userId, shell.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: shell.id } })).status, "ACTIVE");
  assert.equal((await prisma.externalIdentity.findUniqueOrThrow({ where: { provider_subjectHash: { provider: "WECHAT_MINIAPP", subjectHash: crypto.hashIdentity(configuration.WECHAT_MINIAPP_APP_ID, shellOpenId) } } })).userId, shell.id);
  assert.equal(await snapshotAssets(legacy.id), before);
  add("even empty existing accounts require conflict review; their identities sessions and user state remain intact");

  stage = "asset conflict rollback";
  const conflict = await user("Second asset owner", undefined, "asset-conflict-openid"); await assets(conflict.id);
  const conflictAssets = await snapshotAssets(conflict.id);
  const conflictSessionCount = await prisma.session.count();
  await assert.rejects(wxLogin(legacyPhone, "asset-conflict-openid"), (error: any) => error?.getResponse?.().code === "ACCOUNT_LINK_CONFLICT");
  assert.equal(await snapshotAssets(conflict.id), conflictAssets); assert.equal(await snapshotAssets(legacy.id), before);
  assert.equal(await prisma.session.count(), conflictSessionCount);
  assert.equal((await prisma.externalIdentity.findUniqueOrThrow({ where: { provider_subjectHash: { provider: "WECHAT_MINIAPP", subjectHash: crypto.hashIdentity(configuration.WECHAT_MINIAPP_APP_ID, "asset-conflict-openid") } } })).userId, conflict.id);
  add("asset-bearing account conflict rolls back identity/session changes without merging funds or orders");

  stage = "duplicate verified legacy phone fails closed";
  const duplicatePhone = "13800138004", duplicateA = await user("Duplicate A", duplicatePhone), duplicateB = await user("Duplicate B", duplicatePhone);
  await assets(duplicateA.id); await assets(duplicateB.id);
  const duplicatesBefore = [await snapshotAssets(duplicateA.id), await snapshotAssets(duplicateB.id)];
  await assert.rejects(wxLogin(duplicatePhone, "duplicate-openid"), (error: any) => error?.getResponse?.().code === "ACCOUNT_LINK_CONFLICT");
  assert.equal(await prisma.customerPhoneIdentity.count({ where: { phoneHash: phones.hash(duplicatePhone) } }), 0);
  assert.equal(await snapshotAssets(duplicateA.id), duplicatesBefore[0]); assert.equal(await snapshotAssets(duplicateB.id), duplicatesBefore[1]);
  add("two verified legacy users with the same phone require review and retain both sets of data");

  stage = "staff account SMS least privilege";
  stage = "staff account: create user fixture";
  const staffPhone = "13800138005", staff = await user("Test staff", staffPhone, "staff-owned-openid", "OPERATOR");
  stage = "staff account: enabled MFA fixture";
  // Respect the real Mfa_state CHECK: enabled credentials require a nonnegative
  // replay counter. This isolated fixture does not enroll a real user's MFA.
  await prisma.mfaCredential.create({ data: { userId: staff.id, secretEncrypted: crypto.encrypt("acceptance-mfa-placeholder"), enabledAt: new Date(), lastAcceptedStep: 0n } });
  stage = "staff account: SMS challenge request";
  const staffSms = await smsRequest(staffPhone);
  stage = "staff account: SMS confirmation";
  const staffLogin = await login.confirmSms(staffSms.input, ip);
  stage = "staff account: customer-only response assertions";
  assert.equal(staffLogin.user.id, staff.id); assert.deepEqual(staffLogin.user.memberships, []);
  stage = "staff account: SMS session authentication";
  const staffPrincipal = await auth.authenticate(staffLogin.accessToken);
  stage = "staff account: customer-only principal assertions";
  assert.deepEqual(staffPrincipal.memberships, []); assert.equal(staffPrincipal.mfaVerifiedUntil, null); assert.equal(staffPrincipal.staffVerifiedUntil, null); assert.equal(staffPrincipal.wechatIdentityId, null);
  stage = "staff account: unrelated WeChat conflict protection";
  await assert.rejects(wxLogin(staffPhone, "unrelated-new-wechat-openid"), (error: any) => error?.getResponse?.().code === "ACCOUNT_LINK_CONFLICT");
  stage = "staff account: genuine WeChat authorization";
  const genuineStaffWx = await wxLogin(staffPhone, "staff-owned-openid"); assert.equal(genuineStaffWx.user.id, staff.id);
  add("staff-linked SMS stays customer-only and cannot import staff MFA or unrelated WeChat authorization");

  stage = "OTP brute-force and expiry";
  const guessed = await smsRequest("13800138006");
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(login.confirmSms({ ...guessed.input, code: "000000" }, ip));
  assert.equal((await prisma.customerSmsLoginChallenge.findUniqueOrThrow({ where: { id: guessed.response.challengeId } })).attempts, 5);
  await assert.rejects(login.confirmSms(guessed.input, ip));
  const expiring = await smsRequest("13800138007");
  await prisma.customerSmsLoginChallenge.update({ where: { id: expiring.response.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(login.confirmSms(expiring.input, ip));
  assert.equal((await prisma.customerSmsLoginChallenge.findUniqueOrThrow({ where: { id: expiring.response.challengeId } })).status, "EXPIRED");
  add("five guesses lock OTP and expired OTP cannot register or create a session");

  stage = "anonymous request cooldown and rate limits";
  await assert.rejects(login.requestSms({ phone: freshPhone, agreementsAccepted: true }, ip), (error: any) => error?.getStatus?.() === 429);
  const ratePhone = "13800138008", rateIp = "127.0.0.9", rateHash = crypto.hashPhoneVerification("customer-login-ip", rateIp);
  const rateKey = crypto.hashPhoneVerification("customer-login-rate:request-ip-hour", `${rateHash}:${new Date().toISOString().slice(0, 13)}`);
  await prisma.phoneVerificationRateLimit.create({ data: { key: rateKey, count: 20, expiresAt: new Date(Date.now() + 3600000) } });
  await assert.rejects(login.requestSms({ phone: ratePhone, agreementsAccepted: true }, rateIp), (error: any) => error?.getStatus?.() === 429);
  assert.equal(await prisma.customerSmsLoginChallenge.count({ where: { phoneHash: phones.hash(ratePhone) } }), 0);
  add("anonymous phone cooldown and keyed source rate limit prevent provider dispatch");

  stage = "global SMS dispatch budget";
  const globalHourKey = crypto.hashPhoneVerification("customer-login-rate:request-global-hour", new Date().toISOString().slice(0, 13));
  await prisma.phoneVerificationRateLimit.upsert({ where: { key: globalHourKey }, create: { key: globalHourKey, count: 300, expiresAt: new Date(Date.now() + 7200000) }, update: { count: 300 } });
  const dispatchedBefore = smsInbox.size;
  await assert.rejects(login.requestSms({ phone: "13800138010", agreementsAccepted: true }, "127.0.0.10"), (error: any) => error?.getStatus?.() === 429);
  assert.equal(smsInbox.size, dispatchedBefore);
  add("global dispatch budget bounds costs even across different phones and IP addresses");

  stage = "SMS phone authentication snapshot";
  await prisma.user.update({ where: { id: first.value.user.id }, data: { phoneVerifiedAt: new Date(Date.now() + 1) } });
  assert.equal((await auth.authenticate(first.value.accessToken)).userId, first.value.user.id);
  const changedPhone = "13800138999"; allPhones.add(changedPhone);
  await prisma.user.update({ where: { id: first.value.user.id }, data: { phoneEncrypted: crypto.encrypt(changedPhone), phoneVerifiedAt: new Date() } });
  await assert.rejects(auth.authenticate(first.value.accessToken));
  add("SMS tokens survive same-number verification refresh but fail after a changed number is reverified");

  stage = "closed configuration and tampered provenance";
  const closedConfig = new ConfigService({ ...configuration, CUSTOMER_SMS_LOGIN_ENABLED: "false" }) as ConfigService<AppEnv, true>;
  const closed = new CustomerLoginService(prisma as never, crypto, wechat as never, closedConfig, phones, sms as never);
  const closedAuth = new AuthService(prisma as never, crypto, wechat as never, closedConfig, undefined, phones);
  const challengeCountBefore = await prisma.customerSmsLoginChallenge.count();
  await assert.rejects(closed.requestSms({ phone: "13800138009", agreementsAccepted: true }, ip));
  assert.equal(await prisma.customerSmsLoginChallenge.count(), challengeCountBefore);
  await assert.rejects(closedAuth.authenticate(staffLogin.accessToken));
  assert.equal((await closedAuth.authenticate(genuineStaffWx.accessToken)).userId, staff.id);
  const smsSessionRow = await prisma.session.findUniqueOrThrow({ where: { tokenHash: crypto.hashSessionToken(staffLogin.accessToken) } });
  await assert.rejects(prisma.session.update({ where: { id: smsSessionRow.id }, data: { mfaVerifiedUntil: new Date(Date.now() + 60000) } }));
  add("closed SMS gate sends nothing and invalidates SMS sessions; database denies SMS MFA escalation");

  stage = "authentication log privacy";
  const audits = JSON.stringify(await prisma.auditLog.findMany());
  for (const phone of allPhones) assert.equal(audits.includes(phone), false);
  for (const code of deliveredCodes) assert.equal(audits.includes(code), false);
  assert.equal(audits.includes("staff-owned-openid"), false);
  for (const row of await prisma.customerSmsLoginChallenge.findMany()) assert.notEqual(row.phoneEncrypted, crypto.decrypt(row.phoneEncrypted));
  add("audit logs omit plaintext phone OTP and OpenID; challenge records use authenticated ciphertext and keyed hashes");

  console.log(JSON.stringify({ passed: true, checks, counts: { users: await prisma.user.count(), sessions: await prisma.session.count(), phoneBindings: await prisma.customerPhoneIdentity.count(), challenges: await prisma.customerSmsLoginChallenge.count() } }));
} catch (error: unknown) {
  // Neither assertions nor provider/session fixtures may print sensitive values.
  const constructorName = error && typeof error === "object" ? error.constructor?.name : undefined;
  const errorKind = typeof constructorName === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(constructorName) ? constructorName : "UnknownError";
  const candidateCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const errorCode = typeof candidateCode === "string" && /^P[0-9]{4}$/.test(candidateCode) ? candidateCode : undefined;
  // Unknown Prisma errors sometimes wrap a PostgreSQL code in their message.
  // Extract only a five-character allowlisted SQLSTATE; never print the source
  // message, constraint details, stack, metadata or offending row values.
  const unknownSqlCode = error instanceof Prisma.PrismaClientUnknownRequestError
    ? /\bcode\s*:\s*["']([A-Z0-9]{5})["']/.exec(error.message)?.[1] : undefined;
  const sqlState = unknownSqlCode && ["23514", "23505", "23503", "22P02", "55P03", "57014", "25P03"].includes(unknownSqlCode) ? unknownSqlCode : undefined;
  console.error(JSON.stringify({ passed: false, stage, errorKind, ...(errorCode ? { errorCode } : {}), ...(sqlState ? { sqlState } : {}), detail: "Sensitive assertion details omitted; inspect only the isolated acceptance database" }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

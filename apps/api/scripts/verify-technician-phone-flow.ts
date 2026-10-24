import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import sharp from "sharp";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { AuthService } from "../src/auth/auth.service.js";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { CustomerPhoneIdentityService } from "../src/auth/customer-phone-identity.service.js";
import { CustomerLoginService } from "../src/auth/customer-login.service.js";
import { TechnicianPhotoService } from "../src/technicians/technician-photo.service.js";
import { TechnicianNotificationsService } from "../src/orders/technician-notifications.service.js";
import { TechnicianPhoneAuthService } from "../src/auth/technician-phone-auth.service.js";
import { technicianPhoneRouteAllowed } from "../src/auth/session-auth.guard.js";
import { TechniciansService } from "../src/technicians/technicians.service.js";
import { TechnicianWorkbenchService } from "../src/orders/technician-workbench.service.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";

// Never read DATABASE_URL or load dotenv: acceptance must name its dedicated DB.
const url = process.env.TECHNICIAN_PHONE_TEST_DATABASE_URL;
if (!url) throw Error("Set isolated TECHNICIAN_PHONE_TEST_DATABASE_URL");
const target = new URL(url);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !(
    target.pathname === "/zhongyuan_daojia_test" ||
    (process.env.CONFIRM_PRIVATE_ACCEPTANCE_TEST === "true" &&
      ((target.pathname === "/zydj_acceptance_smoke" &&
        target.username === "zydj_acceptance") ||
        /^\/zydj_technician_phone_acceptance_20261022_[a-f0-9]{8,32}$/.test(
          target.pathname,
        )))
  )
)
  throw Error("Refusing non-dedicated test database");
const prisma = new PrismaClient({ datasourceUrl: url });
const prefix = `phone-acceptance-${randomUUID()}`;
const phone = `199${String(randomInt(10_000_000, 100_000_000))}`;
const config = new ConfigService({
  NODE_ENV: "test",
  STAFF_MFA_REQUIRED: "true",
  TECHNICIAN_PHONE_LOGIN_ENABLED: "true",
  TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true",
  SERVICE_CITY: "郑州市",
  TECHNICIAN_PHOTO_PUBLIC_BASE_URL: "https://fixture.invalid/v1",
  AUTH_PROVIDER: "wechat",
  WECHAT_MINIAPP_APP_ID: "wx-fixture",
  WECHAT_MINIAPP_SECRET: "isolated-not-real",
  TECHNICIAN_WECHAT_NOTIFICATIONS_ENABLED: "true",
  TECHNICIAN_WECHAT_TEMPLATE_ID: "isolated_template_not_a_real_template",
  TECHNICIAN_WECHAT_SERVICE_FIELD: "thing1",
  TECHNICIAN_WECHAT_TIME_FIELD: "time2",
  TECHNICIAN_WECHAT_NOTICE_FIELD: "thing3",
  SMS_PROVIDER: "aliyun",
  SMS_SEND_ENABLED: "true",
  PHONE_VERIFICATION_SMS_ENABLED: "true",
  PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT: 20,
  ALIYUN_SMS_ACCESS_KEY_ID: "isolated-test-only",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "isolated-test-only-not-real",
  ALIYUN_SMS_SIGN_NAME: "隔离验收",
  ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_FIXTURE",
  AUTH_SESSION_TTL_SECONDS: 3600,
  AUTH_SESSION_PEPPER: `isolated-test-${randomUUID()}`,
  DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
});
const crypto = new AuthCryptoService(config as never);
const rollback = new Error("ROLLBACK_TECHNICIAN_PHONE_ACCEPTANCE");
const checks: string[] = [];
let passed = false;
try {
  if (await prisma.service.count({ where: { published: true } }))
    throw Error(
      "Dedicated acceptance DB must have no published services; existing rows were not changed",
    );
  await prisma.$transaction(
    async (tx) => {
      // All writes, including counters, challenges and synthetic documents roll back.
      const host = {
        ...tx,
        $transaction: async (operation: (value: typeof tx) => unknown) =>
          operation(tx),
      } as any;
      const phones = new CustomerPhoneIdentityService(host, crypto);
      let sentCode = "",
        smsCalls = 0;
      const sms = {
        submitPhoneVerification: async ({ code }: { code: string }) => {
          sentCode = code;
          smsCalls++;
          return {
            status: "ACCEPTED" as const,
            requestId: "fixture-request",
            bizId: "fixture-biz",
          };
        },
      };
      const login = new TechnicianPhoneAuthService(
        host,
        crypto,
        config as never,
        phones,
        sms as never,
      );
      const auth = new AuthService(host, crypto, {} as never, config as never);
      const access = new AccessControlService(config);
      const technicians = new TechniciansService(
        host,
        access,
        new TechnicianPhotoService(config as never),
        crypto,
        config as never,
      );
      const organization = await tx.organization.create({
        data: { name: prefix },
      });
      const service = await tx.service.create({
        data: {
          organizationId: organization.id,
          slug: prefix,
          name: "隔离验收项目",
          category: "MASSAGE",
          subtitle: "仅隔离测试",
          description: "仅用于隔离测试，非真实服务",
          durationMinutes: 60,
          priceFen: 21800,
          published: true,
          steps: [],
          boundaries: [],
        },
      });
      const receipt = await login.requestSms(
        { phone, agreementsAccepted: true },
        "127.0.0.1",
      );
      const input = {
        phone,
        agreementsAccepted: true as const,
        challengeId: receipt.challengeId,
        challengeSecret: receipt.challengeSecret,
        code: sentCode,
      };
      await assert.rejects(() =>
        login.confirmSms({ ...input, code: "000000" }, "127.0.0.1"),
      );
      assert.equal(
        (
          await tx.technicianPhoneLoginChallenge.findUniqueOrThrow({
            where: { id: receipt.challengeId },
          })
        ).attempts,
        1,
      );
      const session = await login.confirmSms(input, "127.0.0.1");
      assert.equal(smsCalls, 1);
      assert.deepEqual(session.user.memberships, []);
      await assert.rejects(() => login.confirmSms(input, "127.0.0.1"));
      checks.push(
        "OTP proof attempts persist and one-time consumption is enforced by real DB",
      );
      const userId = session.user.id,
        count = await tx.user.count({ where: { id: userId } });
      // Replacing the old provenance CHECK must preserve every old valid pair,
      // including the customer-sms branch's no-assurance restrictions.
      for (const [channel, provider] of [
        ["LEGACY", "unknown"],
        ["WECHAT_MINIAPP", "wechat"],
        ["WECHAT_MINIAPP", "mock"],
        ["ADMIN_BROWSER", "wechat"],
        ["ADMIN_BROWSER", "mock"],
        ["ADMIN_BROWSER", "staff-password"],
        ["CUSTOMER_SMS", "customer-sms"],
      ])
        await tx.session.create({
          data: {
            userId,
            tokenHash: crypto.hashSessionToken(
              `${prefix}-${channel}-${provider}`,
            ),
            expiresAt: new Date(Date.now() + 60000),
            authChannel: channel,
            authProvider: provider,
            ...(channel === "CUSTOMER_SMS"
              ? { customerPhoneHash: phones.hash(phone) }
              : {}),
          },
        });
      checks.push(
        "extended provenance CHECK preserves all seven existing valid source/provider pairs",
      );
      await tx.technicianPhoneLoginChallenge.update({
        where: { id: receipt.challengeId },
        data: { createdAt: new Date(Date.now() - 61000) },
      });
      const again = await login.requestSms(
        { phone, agreementsAccepted: true },
        "127.0.0.1",
      );
      const second = await login.confirmSms(
        {
          phone,
          agreementsAccepted: true,
          challengeId: again.challengeId,
          challengeSecret: again.challengeSecret,
          code: sentCode,
        },
        "127.0.0.1",
      );
      assert.equal(second.user.id, userId);
      assert.equal(await tx.user.count({ where: { id: userId } }), count);
      assert.equal(await tx.staffMembership.count({ where: { userId } }), 0);
      checks.push(
        "same verified phone reuses one canonical user and grants no staff roles",
      );
      let principal = await auth.authenticate(session.accessToken);
      await technicians.registerPhone(principal);
      await technicians.updatePhoneApplication(principal, { bio: "先保存" });
      await assert.rejects(() => technicians.submitPhoneApplication(principal));
      const form = {
        realName: "隔离测试姓名",
        serviceCity: "郑州市",
        serviceAreas: ["金水区"],
        availableTimeSlots: ["MON:09:00-18:00"],
        bio: "隔离验收填写的真实格式服务介绍",
        serviceIds: [service.id],
      };
      await technicians.updatePhoneApplication(principal, form);
      const profile = await tx.technicianProfile.findUniqueOrThrow({
        where: { technicianId: userId },
      });
      const image = (
        await sharp({
          create: { width: 16, height: 16, channels: 3, background: "#176b53" },
        })
          .png()
          .toBuffer()
      ).toString("base64");
      await technicians.uploadPhoneApplicationPhoto(principal, {
        kind: "AVATAR",
        contentBase64: image,
        consentConfirmed: true,
      });
      for (const kind of ["ID_FRONT", "ID_BACK"] as const)
        await technicians.uploadPhoneIdentityDocument(principal, {
          kind,
          contentBase64: image,
        });
      const documents = await tx.technicianIdentityDocument.findMany({
        where: { profileId: profile.id },
      });
      assert.equal(documents.length, 2);
      assert.ok(
        documents.every((d) => d.contentEncrypted !== image && d.width === 16),
      );
      checks.push(
        "real image normalization and photo/document upload persist in the isolated DB; identity bytes stay encrypted",
      );
      assert.equal(
        (await technicians.submitPhoneApplication(principal)).stage,
        "PENDING_REVIEW",
      );
      assert.equal(await tx.staffMembership.count({ where: { userId } }), 0);
      checks.push(
        "partial draft saves; complete explicit submit becomes pending only",
      );
      const operator = await tx.user.create({
        data: {
          role: "CUSTOMER",
          displayName: prefix,
          memberships: {
            create: { organizationId: organization.id, role: "OPERATOR" },
          },
        },
      });
      const admin: AuthPrincipal = {
        sessionId: "isolated-admin",
        userId: operator.id,
        displayName: "隔离审核员",
        authChannel: "ADMIN_BROWSER",
        memberships: [{ organizationId: organization.id, role: "OPERATOR" }],
        mfaVerifiedUntil: new Date(Date.now() + 60000),
      };
      let pending = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: profile.id },
      });
      const beforeVersion = pending.version;
      await assert.rejects(() =>
        technicians.updateAdminApplication(
          { ...admin, memberships: [] },
          organization.id,
          userId,
          {
            expectedVersion: beforeVersion,
            profile: { bio: "不允许的跨权限编辑" },
          },
        ),
      );
      await technicians.updateAdminApplication(admin, organization.id, userId, {
        expectedVersion: beforeVersion,
        profile: {
          realName: "补录验收姓名",
          bio: "后台补充的完整项目服务说明",
        },
      });
      await assert.rejects(() =>
        technicians.updateAdminApplication(admin, organization.id, userId, {
          expectedVersion: beforeVersion,
          profile: { bio: "过期版本" },
        }),
      );
      assert.equal(
        (
          await tx.technicianProfile.findUniqueOrThrow({
            where: { id: profile.id },
          })
        ).status,
        "DRAFT",
      );
      const audit = await tx.auditLog.findFirstOrThrow({
        where: {
          resourceId: profile.id,
          action: "TECHNICIAN_APPLICATION_ADMIN_UPDATED",
        },
      });
      assert.ok(!JSON.stringify(audit.metadata).includes("补录验收姓名"));
      await technicians.submitAdminProfile(admin, organization.id, userId);
      pending = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: profile.id },
      });
      checks.push(
        "operator can supplement private application, stale writes and wrong roles are rejected, audit excludes private values, re-review required",
      );
      await assert.rejects(() =>
        technicians.approve(
          { ...admin, mfaVerifiedUntil: null },
          organization.id,
          userId,
          pending.version,
        ),
      );
      await technicians.approve(
        admin,
        organization.id,
        userId,
        pending.version,
      );
      assert.deepEqual(
        await tx.staffMembership.findMany({
          where: { userId },
          select: { role: true },
        }),
        [{ role: "THERAPIST" }],
      );
      principal = await auth.authenticate(session.accessToken);
      assert.deepEqual(principal.memberships, [
        { organizationId: organization.id, role: "THERAPIST" },
      ]);
      const workbench = new TechnicianWorkbenchService(
        host,
        access,
        {} as never,
        undefined,
        crypto,
        config as never,
      );
      assert.deepEqual((await workbench.get(principal)).orders, []);
      assert.equal(
        technicianPhoneRouteAllowed(
          "POST",
          "/admin/organizations/x/technicians/y/profile/approve",
          true,
        ),
        false,
      );
      assert.equal(
        technicianPhoneRouteAllowed("POST", "/auth/mfa/enrollment", true),
        false,
      );
      checks.push(
        "fresh management MFA is still required; approval grants THERAPIST only; own workbench works",
      );
      const wxLogin = new CustomerLoginService(
        host,
        crypto,
        {
          exchangeCode: async () => ({ openId: `${prefix}-openid` }),
          exchangePhoneCode: async () => ({ phoneNumber: phone }),
        } as never,
        config as never,
        phones,
        sms as never,
      );
      const wxSession = await wxLogin.wechatPhone({
        code: "isolated-code",
        phoneCode: "isolated-phone-code",
        agreementsAccepted: true,
      });
      assert.equal(wxSession.user.id, userId);
      const wxPrincipal = await auth.authenticate(wxSession.accessToken);
      assert.equal(wxPrincipal.authChannel, "WECHAT_MINIAPP");
      let messages = 0;
      const notifications = new TechnicianNotificationsService(
        host,
        config as never,
        crypto,
        {
          sendSubscription: async (payload: { openId: string }) => {
            assert.equal(payload.openId, `${prefix}-openid`);
            messages++;
            return "ACCEPTED";
          },
        } as never,
      );
      const templateId = "isolated_template_not_a_real_template";
      await notifications.subscribe(
        wxPrincipal,
        "isolated_grant_001",
        templateId,
      );
      const grant = await tx.outboxEvent.findFirstOrThrow({
        where: { type: "TECHNICIAN_WECHAT_SUBSCRIPTION", aggregateId: userId },
      });
      const now = new Date();
      const order = await tx.order.create({
        data: {
          orderNo: prefix,
          organizationId: organization.id,
          customerId: operator.id,
          therapistId: userId,
          status: "PAID",
          appointmentStart: new Date(now.getTime() + 3600000),
          appointmentEnd: new Date(now.getTime() + 7200000),
          serviceAmountFen: 21800n,
          travelFeeFen: 0n,
          payableFen: 21800n,
          addressEncrypted: crypto.encrypt("隔离地址"),
          policyVersion: "test",
          idempotencyKey: prefix,
          requestFingerprint: prefix,
          items: {
            create: {
              serviceId: service.id,
              serviceName: service.name,
              durationMinutes: 60,
              unitPriceFen: 21800n,
            },
          },
          payment: {
            create: {
              provider: "WECHAT",
              status: "SUCCEEDED",
              merchantPaymentNo: prefix,
              amountFen: 21800n,
            },
          },
          events: {
            create: { type: "PAYMENT_SUCCEEDED", payload: {}, createdAt: now },
          },
        },
      });
      await notifications.deliverNext(grant.id, userId, now);
      assert.equal(messages, 1);
      await notifications.deliverNext(grant.id, userId, now);
      assert.equal(messages, 1);
      const notice = await tx.outboxEvent.findFirstOrThrow({
        where: { type: "TECHNICIAN_WECHAT_ORDER", aggregateId: order.id },
      });
      assert.equal(notice.lastErrorCode, "PROVIDER_ACCEPTED");
      assert.equal(notice.deliveryStatus, null);
      checks.push(
        "phone-only technician first WeChat attaches to same user; real SQL selects paid own order, consumes grant once, no fake delivery status",
      );
      await tx.staffMembership.updateMany({
        where: { userId },
        data: { status: "SUSPENDED" },
      });
      assert.deepEqual(
        (await auth.authenticate(session.accessToken)).memberships,
        [],
      );
      await assert.rejects(async () =>
        workbench.get(await auth.authenticate(session.accessToken)),
      );
      checks.push(
        "membership suspension revokes technician order access on the next request",
      );
      for (const field of [
        "source",
        "mfa",
        "invalid-hash",
        "old-source-mismatch",
        "customer-assurance",
      ] as const) {
        await tx.$executeRaw`SAVEPOINT technician_phone_invalid_source`;
        let rejected = false;
        try {
          await tx.session.create({
            data: {
              userId,
              tokenHash: crypto.hashSessionToken(`${prefix}-${field}`),
              expiresAt: new Date(Date.now() + 60000),
              authChannel:
                field === "old-source-mismatch"
                  ? "WECHAT_MINIAPP"
                  : field === "customer-assurance"
                    ? "CUSTOMER_SMS"
                    : "TECHNICIAN_PHONE",
              authProvider:
                field === "source" || field === "customer-assurance"
                  ? "customer-sms"
                  : field === "old-source-mismatch"
                    ? "staff-password"
                    : "technician-sms",
              ...(field === "old-source-mismatch"
                ? {}
                : {
                    customerPhoneHash:
                      field === "invalid-hash"
                        ? "not-a-phone-hash"
                        : phones.hash(phone),
                  }),
              ...(field === "mfa" || field === "customer-assurance"
                ? { mfaVerifiedUntil: new Date() }
                : {}),
            },
          });
        } catch {
          rejected = true;
        }
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT technician_phone_invalid_source`;
        await tx.$executeRaw`RELEASE SAVEPOINT technician_phone_invalid_source`;
        assert.equal(
          rejected,
          true,
          "new source CHECK must reject spoofed grants",
        );
      }
      checks.push(
        "database CHECK rejects mismatched source and injected MFA grant",
      );
      await tx.user.update({
        where: { id: userId },
        data: { phoneEncrypted: crypto.encrypt("19800000000") },
      });
      await assert.rejects(() => auth.authenticate(session.accessToken));
      checks.push("rebound phone invalidates the original session");
      passed = true;
      throw rollback;
    },
    { timeout: 60000, maxWait: 5000 },
  );
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await prisma.$disconnect();
}
assert.equal(passed, true);
console.log(
  JSON.stringify(
    { passed: true, rollback: true, realSmsSent: false, checks },
    null,
    2,
  ),
);

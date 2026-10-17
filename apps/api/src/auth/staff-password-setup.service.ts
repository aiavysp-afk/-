import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, type StaffMembership, type User } from "@prisma/client";
import type { AuthSession } from "@zydj/contracts";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { withBoundedAuthTransaction } from "./bounded-auth-transaction.js";
import {
  hashStaffPassword,
  isStaffPasswordValid,
  PasswordHashCapacityError,
} from "./password-hash.js";
import { normalizeStaffLoginAlias } from "./staff-login-account.js";
import { StaffPasswordService } from "./staff-password.service.js";

type Tx = Prisma.TransactionClient;
type StaffUser = User & { memberships: StaffMembership[] };
const MANAGEMENT_ROLES = new Set([
  "OPERATOR",
  "DISPATCHER",
  "FINANCE_REQUESTER",
  "FINANCE_APPROVER",
  "SAFETY_DUTY",
  "ADMIN",
]);
const TTL_MS = 300_000;
const MAX_ATTEMPTS = 5;
const invalidSetup = () =>
  new UnauthorizedException(
    "初始化信息无效或已失效，请重新申请或使用已有登录方式",
  );
const constantEquals = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

// This is one-time activation of an existing authorized account, never account
// registration, password recovery, phone linking or MFA replacement.
@Injectable()
export class StaffPasswordSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly sms: AliyunSmsClient,
    private readonly passwords: StaffPasswordService,
  ) {}

  assertBrowserOrigin(origin?: string) {
    this.passwords.assertBrowserOrigin(origin);
  }

  private gate() {
    if (!this.passwords.configuration().setupEnabled)
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "CONFIGURATION_NOT_READY",
        message: "后台账号首次开通尚未开放，请使用已有登录方式或联系管理员",
      });
  }

  private async take(
    purpose: string,
    subject: string,
    limit: number,
    now: Date,
    windowMs = 3_600_000,
  ) {
    const bucket = Math.floor(now.getTime() / windowMs);
    // Reuse the canonical staff SMS budgets, not a fresh quota for setup.
    const key = this.crypto.hashBrowserLogin(
      `staff-password:rate:${purpose}`,
      `${subject}:${bucket}`,
    );
    const row = await this.prisma.browserLoginRateLimit.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date((bucket + 2) * windowMs) },
      update: { count: { increment: 1 } },
    });
    if (row.count > limit)
      throw new HttpException("请求过于频繁，请稍后重试", 429);
  }

  private phone(user: StaffUser | null): string | null {
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !user.phoneVerifiedAt ||
      !user.phoneEncrypted ||
      !user.memberships.some(
        (membership) =>
          membership.status === "ACTIVE" &&
          MANAGEMENT_ROLES.has(membership.role),
      )
    )
      return null;
    try {
      const phone = this.crypto.decrypt(user.phoneEncrypted);
      return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
    } catch {
      return null;
    }
  }

  private async eligible(tx: Tx, userId: string, phoneHash: string, now: Date) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { status: "ACTIVE" } } },
    });
    const phone = this.phone(user);
    const binding = await tx.customerPhoneIdentity.findUnique({
      where: { phoneHash },
    });
    const credential = await tx.staffPasswordCredential.findUnique({
      where: { userId },
    });
    const mfa = await tx.mfaCredential.findUnique({ where: { userId } });
    if (
      !phone ||
      !user ||
      binding?.userId !== userId ||
      this.crypto.hashPhoneVerification("phone", phone) !== phoneHash ||
      credential ||
      mfa?.enabledAt ||
      (mfa?.enrollmentExpiresAt && mfa.enrollmentExpiresAt > now)
    )
      return null;
    return { user, phone };
  }

  async request(
    input: { phone: string },
    remoteAddress: string,
    now = new Date(),
  ) {
    this.gate();
    if (!/^1[3-9]\d{9}$/.test(input.phone))
      throw new BadRequestException("手机号格式无效");
    const phoneHash = this.crypto.hashPhoneVerification("phone", input.phone);
    // All syntactically valid numbers use the same limits and neutral response.
    // Neither eligibility nor provider acceptance is reported to the caller.
    await this.take("setup-global-request", "all", 300, now);
    await this.take("setup-peer-request", remoteAddress, 20, now);
    await this.take("account-login", phoneHash, 10, now, 600_000);
    await this.take("sms-account-hour", phoneHash, 5, now);
    await this.take("sms-account-day", phoneHash, 10, now, 86_400_000);
    const challengeId = randomUUID();
    const challengeSecret = this.crypto.createSessionToken();
    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + TTL_MS);
    const receipt = {
      challengeId,
      challengeSecret,
      maskedPhone: `${input.phone.slice(0, 3)}****${input.phone.slice(-4)}`,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: 60,
    };
    // Only an already indexed, verified phone binding can identify an account.
    // No scan, identity creation, phone migration or membership grant occurs.
    const binding = await this.prisma.customerPhoneIdentity.findUnique({
      where: { phoneHash },
    });
    if (!binding) return receipt;
    const ready = await withBoundedAuthTransaction(this.prisma, async (tx) => {
      // Same first lock as MFA enrollment and password changes. Their presence
      // is re-read inside the lock, not trusted from a request-time snapshot.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${binding.userId} FOR NO KEY UPDATE`;
      const eligible = await this.eligible(tx, binding.userId, phoneHash, now);
      if (!eligible) return null;
      const recent = await tx.staffPasswordSetupChallenge.findFirst({
        where: {
          userId: binding.userId,
          createdAt: { gt: new Date(now.getTime() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) return null;
      await tx.staffPasswordSetupChallenge.updateMany({
        where: { userId: binding.userId, consumedAt: null },
        data: { status: "REJECTED", consumedAt: now },
      });
      await tx.staffPasswordSetupChallenge.create({
        data: {
          id: challengeId,
          userId: binding.userId,
          phoneHash,
          secretHash: this.crypto.hashBrowserLogin(
            "staff-password-setup:secret",
            challengeSecret,
          ),
          codeHash: this.crypto.hashBrowserLogin(
            "staff-password-setup:code",
            `${challengeId}:${code}`,
          ),
          status: "PENDING",
          createdAt: now,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: binding.userId,
          action: "AUTH_STAFF_PASSWORD_SETUP_REQUESTED",
          resourceType: "StaffPasswordSetupChallenge",
          resourceId: challengeId,
          metadata: { channel: "ALIYUN_SMS" },
        },
      });
      return { phone: eligible.phone, userId: binding.userId };
    });
    if (!ready) return receipt;
    let submission: Awaited<
      ReturnType<AliyunSmsClient["submitPhoneVerification"]>
    >;
    try {
      // The existing client reserves the shared verification SMS daily budget
      // before I/O. Never refund UNKNOWN/failure or retry automatically.
      submission = await this.sms.submitPhoneVerification({
        phone: ready.phone,
        code,
        trackingId: challengeId,
      });
    } catch {
      await this.prisma.staffPasswordSetupChallenge.updateMany({
        where: { id: challengeId, status: "PENDING", consumedAt: null },
        data: { status: "REJECTED" },
      });
      await this.deliveryAudit(ready.userId, challengeId, "UNAVAILABLE");
      return receipt;
    }
    await this.prisma.staffPasswordSetupChallenge.updateMany({
      where: { id: challengeId, status: "PENDING", consumedAt: null },
      data: {
        status: submission.status,
        ...(submission.status === "ACCEPTED"
          ? {
              providerRequestId: submission.requestId,
              providerBizId: submission.bizId,
            }
          : {}),
      },
    });
    await this.deliveryAudit(ready.userId, challengeId, submission.status);
    return receipt;
  }

  async confirm(
    input: {
      challengeId: string;
      challengeSecret: string;
      code: string;
      loginAlias: string;
      password: string;
    },
    remoteAddress: string,
    now = new Date(),
  ): Promise<AuthSession> {
    this.gate();
    const loginAlias = normalizeStaffLoginAlias(input.loginAlias);
    if (!loginAlias || !isStaffPasswordValid(input.password))
      throw new BadRequestException("登录名或密码格式无效");
    await this.take("setup-global-confirm", "all", 3_000, now);
    await this.take("setup-peer-confirm", remoteAddress, 120, now);
    await this.take(
      "setup-challenge-confirm",
      input.challengeId,
      30,
      now,
      600_000,
    );
    const snapshot = await this.prisma.staffPasswordSetupChallenge.findUnique({
      where: { id: input.challengeId },
    });
    if (!snapshot) throw invalidSetup();
    let result: AuthSession | null;
    try {
      result = await withBoundedAuthTransaction(this.prisma, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${snapshot.userId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "StaffPasswordSetupChallenge" WHERE "id" = ${input.challengeId} FOR UPDATE`;
        const challenge = await tx.staffPasswordSetupChallenge.findUnique({
          where: { id: input.challengeId },
        });
        if (
          !challenge ||
          challenge.userId !== snapshot.userId ||
          challenge.consumedAt ||
          !["ACCEPTED", "UNKNOWN"].includes(challenge.status) ||
          challenge.expiresAt <= now ||
          challenge.createdAt > now ||
          challenge.attempts >= MAX_ATTEMPTS
        )
          return null;
        const eligible = await this.eligible(
          tx,
          snapshot.userId,
          challenge.phoneHash,
          now,
        );
        if (!eligible) {
          await tx.staffPasswordSetupChallenge.update({
            where: { id: challenge.id },
            data: { status: "REJECTED", consumedAt: now },
          });
          return null;
        }
        const secretValid = constantEquals(
          this.crypto.hashBrowserLogin(
            "staff-password-setup:secret",
            input.challengeSecret,
          ),
          challenge.secretHash,
        );
        const codeValid = constantEquals(
          this.crypto.hashBrowserLogin(
            "staff-password-setup:code",
            `${challenge.id}:${input.code}`,
          ),
          challenge.codeHash,
        );
        if (!secretValid || !codeValid) {
          const attempts = challenge.attempts + 1;
          await tx.staffPasswordSetupChallenge.update({
            where: { id: challenge.id },
            data: {
              attempts,
              ...(attempts >= MAX_ATTEMPTS
                ? { status: "REJECTED", consumedAt: now }
                : {}),
            },
          });
          return null;
        }
        const consumed = await tx.staffPasswordSetupChallenge.updateMany({
          where: {
            id: challenge.id,
            consumedAt: null,
            status: { in: ["ACCEPTED", "UNKNOWN"] },
            expiresAt: { gt: now },
            attempts: { lt: MAX_ATTEMPTS },
          },
          data: { status: "CONSUMED", consumedAt: now },
        });
        if (consumed.count !== 1) return null;
        let passwordHash: string;
        try {
          passwordHash = await hashStaffPassword(input.password);
        } catch (error) {
          if (error instanceof PasswordHashCapacityError)
            throw new HttpException("密码校验繁忙，请稍后重试", 429);
          throw error;
        }
        // create, never upsert: even a concurrent external writer cannot turn
        // this first-time flow into password reset or credential replacement.
        const credential = await tx.staffPasswordCredential.create({
          data: {
            userId: eligible.user.id,
            phoneHash: challenge.phoneHash,
            loginAlias,
            passwordHash,
            version: 1,
          },
        });
        await tx.staffPasswordSetupChallenge.updateMany({
          where: {
            userId: eligible.user.id,
            id: { not: challenge.id },
            consumedAt: null,
          },
          data: { status: "REJECTED", consumedAt: now },
        });
        const accessToken = this.crypto.createSessionToken();
        const expiresAt = new Date(now.getTime() + 3_600_000);
        const session = await tx.session.create({
          data: {
            userId: eligible.user.id,
            tokenHash: this.crypto.hashSessionToken(accessToken),
            createdAt: now,
            expiresAt,
            authChannel: "ADMIN_BROWSER",
            authProvider: "staff-password",
            mfaVerifiedUntil: null,
            staffVerifiedUntil: expiresAt,
            staffVerificationMethod: "PASSWORD_SMS",
            staffPasswordVersion: credential.version,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: eligible.user.id,
            action: "AUTH_STAFF_PASSWORD_SETUP_SUCCEEDED",
            resourceType: "Session",
            resourceId: session.id,
            metadata: {
              method: "PASSWORD_SMS",
              credentialVersion: 1,
              loginAliasConfigured: true,
            },
          },
        });
        return {
          accessToken,
          expiresAt: expiresAt.toISOString(),
          user: {
            id: eligible.user.id,
            displayName: eligible.user.displayName,
            phoneVerified: true,
            memberships: eligible.user.memberships.map((membership) => ({
              organizationId: membership.organizationId,
              role: membership.role,
            })),
          },
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException("登录名不可用");
      throw error;
    }
    if (!result) throw invalidSetup();
    return result;
  }

  private async deliveryAudit(
    userId: string,
    challengeId: string,
    outcome: string,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "AUTH_STAFF_PASSWORD_SETUP_SMS_RESULT",
        resourceType: "StaffPasswordSetupChallenge",
        resourceId: challengeId,
        // Deliberately exclude provider errors, destination and all proofs.
        metadata: { outcome },
      },
    });
  }
}

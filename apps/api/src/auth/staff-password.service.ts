import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type User, type StaffMembership } from "@prisma/client";
import type { AuthSession } from "@zydj/contracts";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { BrowserLoginService } from "./browser-login.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import {
  normalizeStaffLoginAccount,
  normalizeStaffLoginAlias,
} from "./staff-login-account.js";
import {
  DUMMY_STAFF_PASSWORD_HASH,
  hashStaffPassword,
  isStaffPasswordValid,
  PasswordHashCapacityError,
  verifyStaffPassword,
} from "./password-hash.js";

const CHALLENGE_TTL_MS = 300_000;
const LOCK_MS = 900_000;
const MAX_FAILURES = 5;
type StaffUser = User & { memberships: StaffMembership[] };
const invalidLogin = () =>
  new UnauthorizedException("登录信息无效，请检查账号、密码或验证码后重试");
const constantEquals = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

@Injectable()
export class StaffPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly config: ConfigService,
    private readonly sms: AliyunSmsClient,
    private readonly browser: BrowserLoginService,
  ) {}

  configuration() {
    const enabled =
      this.config.get("STAFF_PASSWORD_LOGIN_ENABLED") === "true" &&
      !(
        this.config.get("NODE_ENV") === "production" &&
        this.config.get("AUTH_PROVIDER") !== "wechat"
      );
    const smsEnabled =
      this.config.get("SMS_PROVIDER") === "aliyun" &&
      this.config.get("SMS_SEND_ENABLED") === "true" &&
      this.config.get("PHONE_VERIFICATION_SMS_ENABLED") === "true" &&
      /^SMS_[A-Za-z0-9]+$/.test(
        String(
          this.config.get("ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE") ?? "",
        ),
      ) &&
      [
        "ALIYUN_SMS_ACCESS_KEY_ID",
        "ALIYUN_SMS_ACCESS_KEY_SECRET",
        "ALIYUN_SMS_SIGN_NAME",
      ].every((name) => Boolean(String(this.config.get(name) ?? "").trim()));
    return { enabled, smsEnabled: enabled && smsEnabled };
  }

  assertBrowserOrigin(origin?: string) {
    this.browser.assertBrowserOrigin(origin);
  }

  private gate(requireSms = false) {
    const state = this.configuration();
    if (!state.enabled || (requireSms && !state.smsEnabled))
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "CONFIGURATION_NOT_READY",
        message: "账号密码短信登录尚未开放，请使用微信登录",
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
    const key = this.crypto.hashBrowserLogin(
      `staff-password:rate:${purpose}`,
      `${subject}:${bucket}`,
    );
    const row = await this.prisma.browserLoginRateLimit.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date((bucket + 2) * windowMs) },
      update: { count: { increment: 1 } },
    });
    // This mutation is outside any later auth transaction: denied attempts
    // must consume the budget instead of rolling it back with an exception.
    if (row.count > limit)
      throw new HttpException("登录请求过于频繁，请稍后重试", 429);
  }

  private phone(user: StaffUser | null): string | null {
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !user.phoneVerifiedAt ||
      !user.phoneEncrypted ||
      !user.memberships.some((membership) => membership.role !== "CUSTOMER")
    )
      return null;
    try {
      const phone = this.crypto.decrypt(user.phoneEncrypted);
      return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
    } catch {
      return null;
    }
  }

  async status(principal: AuthPrincipal) {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      include: { memberships: { where: { status: "ACTIVE" } } },
    });
    const phone = this.phone(user);
    if (principal.authChannel !== "ADMIN_BROWSER" || !phone)
      throw new ForbiddenException(
        "只有已授权并验证手机号的后台人员可管理登录密码",
      );
    const credential = await this.prisma.staffPasswordCredential.findUnique({
      where: { userId: principal.userId },
    });
    return {
      configured: Boolean(
        credential &&
          credential.phoneHash ===
            this.crypto.hashPhoneVerification("phone", phone),
      ),
      maskedAccount: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      loginAlias: credential?.loginAlias ?? null,
      ...(credential ? { changedAt: credential.updatedAt.toISOString() } : {}),
    };
  }

  async setPassword(
    principal: AuthPrincipal,
    password: string,
    now = new Date(),
    loginAlias?: string,
  ) {
    this.gate();
    const normalizedAlias =
      loginAlias === undefined
        ? undefined
        : typeof loginAlias === "string"
          ? normalizeStaffLoginAlias(loginAlias)
          : null;
    if (normalizedAlias === null)
      throw new BadRequestException("登录名格式无效");
    if (!isStaffPasswordValid(password))
      throw new BadRequestException("密码须为12至128个字符");
    if (principal.authChannel !== "ADMIN_BROWSER")
      throw new ForbiddenException("请在后台管理本人密码");
    await this.take("password-set", principal.userId, 10, now);
    const passwordHash = await this.hashPassword(password);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${principal.sessionId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: principal.userId },
          include: { memberships: { where: { status: "ACTIVE" } } },
        });
        const session = await tx.session.findUnique({
          where: { id: principal.sessionId },
        });
        const phone = this.phone(user);
        if (
          !phone ||
          !session ||
          session.userId !== principal.userId ||
          session.revokedAt ||
          session.expiresAt <= now ||
          session.createdAt > now ||
          session.authChannel !== "ADMIN_BROWSER"
        )
          throw invalidLogin();
        if (!session.mfaVerifiedUntil || session.mfaVerifiedUntil <= now)
          throw new ForbiddenException("设置或更改密码前请验证当前动态码");
        const credential = await tx.staffPasswordCredential.upsert({
          where: { userId: principal.userId },
          create: {
            userId: principal.userId,
            phoneHash: this.crypto.hashPhoneVerification("phone", phone),
            passwordHash,
            ...(normalizedAlias === undefined
              ? {}
              : { loginAlias: normalizedAlias }),
          },
          update: {
            phoneHash: this.crypto.hashPhoneVerification("phone", phone),
            passwordHash,
            ...(normalizedAlias === undefined
              ? {}
              : { loginAlias: normalizedAlias }),
            version: { increment: 1 },
            failedAttempts: 0,
            lockedUntil: null,
          },
        });
        await tx.staffTrustedDevice.updateMany({
          where: { userId: principal.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.staffPasswordLoginChallenge.updateMany({
          where: { userId: principal.userId, consumedAt: null },
          data: { status: "REJECTED", consumedAt: now },
        });
        await tx.session.updateMany({
          where: {
            userId: principal.userId,
            id: { not: principal.sessionId },
            authChannel: "ADMIN_BROWSER",
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        // The session that proved fresh TOTP is allowed to continue even if it
        // originally came from password or remembered-device login.
        await tx.session.update({
          where: { id: principal.sessionId },
          data: {
            staffPasswordVersion: credential.version,
            trustedDeviceId: null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            action: "AUTH_STAFF_PASSWORD_CHANGED",
            resourceType: "User",
            resourceId: principal.userId,
            metadata: {
              credentialVersion: credential.version,
              loginAliasConfigured: Boolean(credential.loginAlias),
              otherBrowserSessionsRevoked: true,
              trustedDevicesRevoked: true,
            },
          },
        });
      });
    } catch (error) {
      // Database uniqueness is the final concurrency boundary. Do not expose
      // the conflicting value, its owner, or raw database constraint details.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException("登录名不可用");
      throw error;
    }
    return { configured: true };
  }

  async login(
    input: { account: string; password: string },
    remoteAddress: string,
    now = new Date(),
  ) {
    this.gate(true);
    const account = normalizeStaffLoginAccount(input.account);
    if (!account || !isStaffPasswordValid(input.password)) throw invalidLogin();
    await this.take("global-login", "all", 1_000, now);
    await this.take("peer-login", remoteAddress, 60, now);
    const lookupHash =
      account.kind === "phone"
        ? this.crypto.hashPhoneVerification("phone", account.value)
        : this.crypto.hashBrowserLogin(
            "staff-password:alias-lookup",
            account.value,
          );
    // Bound unknown alias traffic before lookup. Known aliases also consume
    // the same canonical phone budget as phone login, so alternating methods
    // cannot multiply the account's password-guess or SMS quota.
    await this.take(
      account.kind === "phone" ? "account-login" : "alias-lookup",
      lookupHash,
      10,
      now,
      600_000,
    );
    const snapshot = await this.prisma.staffPasswordCredential.findUnique({
      where:
        account.kind === "phone"
          ? { phoneHash: lookupHash }
          : { loginAlias: account.value },
    });
    if (account.kind === "alias")
      await this.take(
        "account-login",
        snapshot?.phoneHash ?? lookupHash,
        10,
        now,
        600_000,
      );
    const valid = await this.verifyPassword(
      input.password,
      snapshot?.passwordHash ?? DUMMY_STAFF_PASSWORD_HASH,
    );
    if (!snapshot) throw invalidLogin();
    const phoneHash = snapshot.phoneHash;
    if (valid) {
      await this.take("sms-account-hour", phoneHash, 5, now);
      await this.take("sms-account-day", phoneHash, 10, now, 86_400_000);
    }
    const challengeId = randomUUID(),
      challengeSecret = this.crypto.createSessionToken();
    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${snapshot.userId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "userId" FROM "StaffPasswordCredential" WHERE "userId" = ${snapshot.userId} FOR UPDATE`;
      const credential = await tx.staffPasswordCredential.findUnique({
        where: { userId: snapshot.userId },
      });
      const user = await tx.user.findUnique({
        where: { id: snapshot.userId },
        include: { memberships: { where: { status: "ACTIVE" } } },
      });
      const phone = this.phone(user);
      if (
        !credential ||
        !phone ||
        credential.phoneHash !== phoneHash ||
        (account.kind === "alias" && credential.loginAlias !== account.value) ||
        this.crypto.hashPhoneVerification("phone", phone) !== phoneHash ||
        credential.version !== snapshot.version ||
        credential.passwordHash !== snapshot.passwordHash ||
        (credential.lockedUntil && credential.lockedUntil > now)
      )
        return null;
      if (!valid) {
        const failures =
          (credential.lockedUntil && credential.lockedUntil <= now
            ? 0
            : credential.failedAttempts) + 1;
        await tx.staffPasswordCredential.update({
          where: { userId: snapshot.userId },
          data: {
            failedAttempts: failures,
            lockedUntil:
              failures >= MAX_FAILURES
                ? new Date(now.getTime() + LOCK_MS)
                : null,
          },
        });
        return null;
      }
      const recent = await tx.staffPasswordLoginChallenge.findFirst({
        where: {
          userId: snapshot.userId,
          createdAt: { gt: new Date(now.getTime() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) return "cooldown" as const;
      await tx.staffPasswordCredential.update({
        where: { userId: snapshot.userId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      // Only the current verified phone decrypted from the existing user is
      // ever sent to the provider. Client-supplied account is a lookup, not a
      // freely selectable SMS destination.
      await tx.staffPasswordLoginChallenge.create({
        data: {
          id: challengeId,
          userId: snapshot.userId,
          passwordVersion: credential.version,
          phoneHash,
          secretHash: this.crypto.hashBrowserLogin(
            "staff-password:secret",
            challengeSecret,
          ),
          codeHash: this.crypto.hashBrowserLogin(
            "staff-password:code",
            `${challengeId}:${code}`,
          ),
          status: "PENDING",
          createdAt: now,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: snapshot.userId,
          action: "AUTH_STAFF_PASSWORD_SMS_REQUESTED",
          resourceType: "StaffPasswordLoginChallenge",
          resourceId: challengeId,
          metadata: { channel: "ALIYUN_SMS" },
        },
      });
      return { phone };
    });
    if (!result) throw invalidLogin();
    if (result === "cooldown")
      throw new HttpException("请稍后再获取登录验证码", 429);
    let submission: Awaited<
      ReturnType<AliyunSmsClient["submitPhoneVerification"]>
    >;
    try {
      submission = await this.sms.submitPhoneVerification({
        phone: result.phone,
        code,
        trackingId: challengeId,
      });
    } catch {
      await this.prisma.staffPasswordLoginChallenge.updateMany({
        where: { id: challengeId, status: "PENDING", consumedAt: null },
        data: { status: "REJECTED" },
      });
      throw new ServiceUnavailableException(
        "登录验证码发送失败，请使用微信登录或稍后重试",
      );
    }
    // Do not resurrect a challenge invalidated during an in-flight provider
    // call by a password reset, role removal or another login process.
    const updated = await this.prisma.staffPasswordLoginChallenge.updateMany({
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
    if (submission.status === "REJECTED")
      throw new ServiceUnavailableException("登录验证码发送失败，请稍后重试");
    if (updated.count !== 1) throw invalidLogin();
    return {
      challengeId,
      challengeSecret,
      maskedPhone: `${result.phone.slice(0, 3)}****${result.phone.slice(-4)}`,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: 60,
    };
  }

  async confirm(
    input: { challengeId: string; challengeSecret: string; code: string },
    remoteAddress: string,
    now = new Date(),
  ): Promise<AuthSession> {
    this.gate(true);
    await this.take("global-confirm", "all", 3_000, now);
    await this.take("peer-confirm", remoteAddress, 120, now);
    await this.take("challenge-confirm", input.challengeId, 30, now, 600_000);
    const snapshot = await this.prisma.staffPasswordLoginChallenge.findUnique({
      where: { id: input.challengeId },
    });
    if (!snapshot) throw invalidLogin();
    const result = await this.prisma.$transaction(async (tx) => {
      // Consistent User -> credential -> challenge locking linearizes password
      // changes and concurrent confirmations; a single challenge yields one
      // browser session even across multiple API instances.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${snapshot.userId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "userId" FROM "StaffPasswordCredential" WHERE "userId" = ${snapshot.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "StaffPasswordLoginChallenge" WHERE "id" = ${input.challengeId} FOR UPDATE`;
      const challenge = await tx.staffPasswordLoginChallenge.findUnique({
        where: { id: input.challengeId },
      });
      const credential = await tx.staffPasswordCredential.findUnique({
        where: { userId: snapshot.userId },
      });
      const user = await tx.user.findUnique({
        where: { id: snapshot.userId },
        include: { memberships: { where: { status: "ACTIVE" } } },
      });
      const phone = this.phone(user);
      if (
        !challenge ||
        challenge.userId !== snapshot.userId ||
        challenge.consumedAt ||
        !["ACCEPTED", "UNKNOWN"].includes(challenge.status) ||
        challenge.expiresAt <= now ||
        challenge.createdAt > now ||
        challenge.attempts >= MAX_FAILURES
      )
        return null;
      if (
        !credential ||
        !phone ||
        !user ||
        credential.version !== challenge.passwordVersion ||
        credential.phoneHash !== challenge.phoneHash ||
        this.crypto.hashPhoneVerification("phone", phone) !==
          challenge.phoneHash ||
        (credential.lockedUntil && credential.lockedUntil > now)
      ) {
        await tx.staffPasswordLoginChallenge.update({
          where: { id: challenge.id },
          data: { status: "REJECTED", consumedAt: now },
        });
        return null;
      }
      const secretValid = constantEquals(
        this.crypto.hashBrowserLogin(
          "staff-password:secret",
          input.challengeSecret,
        ),
        challenge.secretHash,
      );
      const codeValid = constantEquals(
        this.crypto.hashBrowserLogin(
          "staff-password:code",
          `${challenge.id}:${input.code}`,
        ),
        challenge.codeHash,
      );
      if (!secretValid || !codeValid) {
        const attempts = challenge.attempts + 1;
        await tx.staffPasswordLoginChallenge.update({
          where: { id: challenge.id },
          data: {
            attempts,
            ...(attempts >= MAX_FAILURES
              ? { status: "REJECTED", consumedAt: now }
              : {}),
          },
        });
        return null;
      }
      const consumed = await tx.staffPasswordLoginChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          status: { in: ["ACCEPTED", "UNKNOWN"] },
          expiresAt: { gt: now },
          attempts: { lt: MAX_FAILURES },
        },
        data: { status: "CONSUMED", consumedAt: now },
      });
      if (consumed.count !== 1) return null;
      const accessToken = this.crypto.createSessionToken(),
        expiresAt = new Date(now.getTime() + 3_600_000);
      const session = await tx.session.create({
        data: {
          userId: user.id,
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
          actorId: user.id,
          action: "AUTH_STAFF_PASSWORD_LOGIN_SUCCEEDED",
          resourceType: "Session",
          resourceId: session.id,
          metadata: {
            method: "PASSWORD_SMS",
            credentialVersion: credential.version,
          },
        },
      });
      return {
        accessToken,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: user.id,
          displayName: user.displayName,
          phoneVerified: true,
          memberships: user.memberships.map((membership) => ({
            organizationId: membership.organizationId,
            role: membership.role,
          })),
        },
      };
    });
    if (!result) throw invalidLogin();
    return result;
  }

  private async hashPassword(password: string) {
    try {
      return await hashStaffPassword(password);
    } catch (error) {
      if (error instanceof PasswordHashCapacityError)
        throw new HttpException("密码校验繁忙，请稍后重试", 429);
      throw error;
    }
  }

  private async verifyPassword(password: string, hash: string) {
    try {
      return await verifyStaffPassword(password, hash);
    } catch (error) {
      if (error instanceof PasswordHashCapacityError)
        throw new HttpException("密码校验繁忙，请稍后重试", 429);
      throw error;
    }
  }
}

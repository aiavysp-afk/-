import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  IdentityProvider,
  MembershipStatus,
  Prisma,
  UserRole,
} from "@prisma/client";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AuthSession,
  CustomerLoginCapabilities,
  CustomerSmsLoginConfirm,
  CustomerSmsLoginRequest,
  CustomerSmsLoginRequestResult,
  CustomerWechatPhoneLoginRequest,
} from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import {
  accountLinkConflict,
  CustomerPhoneIdentityService,
} from "./customer-phone-identity.service.js";
import {
  WechatMiniappClient,
  type WechatIdentityResult,
} from "./wechat-miniapp.client.js";
import { withBoundedAuthTransaction } from "./bounded-auth-transaction.js";

type Tx = Prisma.TransactionClient;
const SMS_TTL_MS = 5 * 60_000;
const RESEND_MS = 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class CustomerLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly wechat: WechatMiniappClient,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly phones: CustomerPhoneIdentityService,
    private readonly sms: AliyunSmsClient,
  ) {}

  capabilities(): CustomerLoginCapabilities {
    const provider = this.config.get("AUTH_PROVIDER", { infer: true });
    const wechatPhoneLoginEnabled =
      provider === "mock"
        ? this.config.get("NODE_ENV", { infer: true }) !== "production"
        : !!this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true })?.trim() &&
          !!this.config.get("WECHAT_MINIAPP_SECRET", { infer: true })?.trim();
    const smsLoginEnabled =
      this.config.get("CUSTOMER_SMS_LOGIN_ENABLED", { infer: true }) ===
        "true" &&
      this.config.get("PHONE_VERIFICATION_SMS_ENABLED", { infer: true }) ===
        "true" &&
      this.config.get("SMS_PROVIDER", { infer: true }) === "aliyun" &&
      this.config.get("SMS_SEND_ENABLED", { infer: true }) === "true" &&
      !!this.config.get("ALIYUN_SMS_ACCESS_KEY_ID", { infer: true })?.trim() &&
      !!this.config
        .get("ALIYUN_SMS_ACCESS_KEY_SECRET", { infer: true })
        ?.trim() &&
      !!this.config.get("ALIYUN_SMS_SIGN_NAME", { infer: true })?.trim() &&
      /^SMS_[A-Za-z0-9]+$/.test(
        this.config.get("ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE", {
          infer: true,
        }) ?? "",
      );
    return {
      wechatPhoneLoginEnabled,
      smsLoginEnabled,
      ...(!smsLoginEnabled
        ? { smsUnavailableReason: "短信登录尚未开通，请使用微信一键登录" }
        : {}),
    };
  }

  async wechatPhone(
    input: CustomerWechatPhoneLoginRequest,
  ): Promise<AuthSession> {
    this.assertAgreements(input.agreementsAccepted);
    if (!this.capabilities().wechatPhoneLoginEnabled)
      throw configurationNotReady("微信一键登录尚未就绪");
    // Neither request-supplied phone/openid nor a client success flag is trusted.
    const [identity, { phoneNumber }] = await Promise.all([
      this.wechat.exchangeCode(input.code),
      this.wechat.exchangePhoneCode(input.phoneCode),
    ]);
    return withBoundedAuthTransaction(this.prisma, async (tx) => {
      await this.phones.lock(tx, phoneNumber);
      const { userId, identityId } = await this.resolveWechatPhone(
        tx,
        identity,
        phoneNumber,
      );
      return this.createSession(
        tx,
        userId,
        "WECHAT_MINIAPP",
        this.config.get("AUTH_PROVIDER", { infer: true }),
        identityId,
      );
    });
  }

  async requestSms(
    input: CustomerSmsLoginRequest,
    requestIp: string,
  ): Promise<CustomerSmsLoginRequestResult> {
    this.assertAgreements(input.agreementsAccepted);
    this.assertSmsEnabled();
    const now = new Date();
    const challengeId = randomUUID();
    const code = String(randomInt(100_000, 1_000_000));
    const phoneHash = this.phones.hash(input.phone);
    const requestIpHash = this.hashIp(requestIp);
    const expiresAt = new Date(now.getTime() + SMS_TTL_MS);
    await withBoundedAuthTransaction(this.prisma, async (tx) => {
      // Aggregate budgets also bound provider costs under distributed/forged IPs.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('customer-login-global-sms-budget', 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-login-ip:${requestIpHash}`}, 0))`;
      await this.phones.lock(tx, input.phone);
      const recent = await tx.customerSmsLoginChallenge.findFirst({
        where: {
          phoneHash,
          createdAt: { gt: new Date(now.getTime() - RESEND_MS) },
        },
        select: { id: true },
      });
      if (recent) throw tooManyRequests("请 60 秒后再获取验证码");
      const hour = now.toISOString().slice(0, 13);
      const day = now.toISOString().slice(0, 10);
      await this.rateLimit(
        tx,
        "request-global-minute",
        now.toISOString().slice(0, 16),
        50,
        now,
      );
      await this.rateLimit(tx, "request-global-hour", hour, 300, now);
      await this.rateLimit(
        tx,
        "request-ip-hour",
        `${requestIpHash}:${hour}`,
        20,
        now,
      );
      await this.rateLimit(
        tx,
        "request-phone-hour",
        `${phoneHash}:${hour}`,
        5,
        now,
      );
      await this.rateLimit(
        tx,
        "request-phone-day",
        `${phoneHash}:${day}`,
        10,
        now,
      );
      await tx.customerSmsLoginChallenge.create({
        data: {
          id: challengeId,
          phoneHash,
          phoneEncrypted: this.crypto.encrypt(input.phone),
          requestIpHash,
          codeHash: this.crypto.hashPhoneVerification(
            "customer-login-code",
            `${challengeId}:${code}`,
          ),
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "AUTH_CUSTOMER_SMS_REQUESTED",
          resourceType: "CustomerSmsLoginChallenge",
          resourceId: challengeId,
          metadata: { channel: "ALIYUN_SMS", agreementsAccepted: true },
        },
      });
    });
    let submission: Awaited<
      ReturnType<AliyunSmsClient["submitPhoneVerification"]>
    >;
    try {
      submission = await this.sms.submitPhoneVerification({
        phone: input.phone,
        code,
        trackingId: challengeId,
      });
    } catch (error) {
      await this.prisma.customerSmsLoginChallenge.updateMany({
        where: { id: challengeId, status: "PENDING" },
        data: { status: "REJECTED" },
      });
      throw error;
    }
    await this.prisma.customerSmsLoginChallenge.update({
      where: { id: challengeId },
      data:
        submission.status === "ACCEPTED"
          ? {
              status: "ACCEPTED",
              providerRequestId: submission.requestId,
              providerBizId: submission.bizId,
            }
          : { status: submission.status },
    });
    if (submission.status === "REJECTED")
      throw new ServiceUnavailableException("验证码发送失败，请稍后重试");
    // SENT means provider accepted, not guaranteed handset delivery.
    return {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: RESEND_MS / 1_000,
      status: submission.status === "ACCEPTED" ? "SENT" : "UNKNOWN",
    };
  }

  async confirmSms(
    input: CustomerSmsLoginConfirm,
    requestIp: string,
  ): Promise<AuthSession> {
    this.assertAgreements(input.agreementsAccepted);
    this.assertSmsEnabled();
    const now = new Date();
    const requestIpHash = this.hashIp(requestIp);
    // Commit the failed-attempt counter instead of throwing inside its transaction.
    const result = await withBoundedAuthTransaction(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-login-challenge:${input.challengeId}`}, 0))`;
      await this.rateLimit(
        tx,
        "confirm-ip-hour",
        `${requestIpHash}:${now.toISOString().slice(0, 13)}`,
        100,
        now,
      );
      const challenge = await tx.customerSmsLoginChallenge.findUnique({
        where: { id: input.challengeId },
      });
      if (
        !challenge ||
        challenge.phoneHash !== this.phones.hash(input.phone) ||
        challenge.consumedAt ||
        !["ACCEPTED", "UNKNOWN"].includes(challenge.status)
      )
        return { error: "INVALID" as const };
      if (challenge.expiresAt <= now) {
        await tx.customerSmsLoginChallenge.update({
          where: { id: challenge.id },
          data: { status: "EXPIRED" },
        });
        return { error: "EXPIRED" as const };
      }
      if (challenge.attempts >= MAX_ATTEMPTS)
        return { error: "ATTEMPTS" as const };
      const candidate = this.crypto.hashPhoneVerification(
        "customer-login-code",
        `${challenge.id}:${input.code}`,
      );
      if (!safeEqual(challenge.codeHash, candidate)) {
        await tx.customerSmsLoginChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        return { error: "INVALID" as const };
      }
      // Check the encrypted stored phone as well as the keyed lookup hash.
      if (this.crypto.decrypt(challenge.phoneEncrypted) !== input.phone)
        return { error: "INVALID" as const };
      await this.phones.lock(tx, input.phone);
      let userId = await this.phones.findOwner(tx, input.phone);
      if (!userId) {
        const user = await tx.user.create({
          data: {
            role: UserRole.CUSTOMER,
            displayName: "手机用户",
            phoneEncrypted: this.crypto.encrypt(input.phone),
            phoneVerifiedAt: now,
          },
          select: { id: true },
        });
        userId = user.id;
        await this.phones.register(tx, userId, input.phone);
      }
      const consumed = await tx.customerSmsLoginChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          attempts: { lt: MAX_ATTEMPTS },
          expiresAt: { gt: now },
          status: { in: ["ACCEPTED", "UNKNOWN"] },
        },
        data: { consumedAt: now, status: "CONSUMED" },
      });
      if (consumed.count !== 1)
        throw new BadRequestException("验证码无效或已使用，请重新获取");
      return {
        session: await this.createSession(
          tx,
          userId,
          "CUSTOMER_SMS",
          "customer-sms",
          null,
          this.phones.hash(input.phone),
        ),
      };
    });
    if (result.session) return result.session;
    if (result.error === "ATTEMPTS")
      throw tooManyRequests("验证码尝试次数过多，请重新获取");
    if (result.error === "EXPIRED")
      throw new BadRequestException("验证码已过期，请重新获取");
    throw new BadRequestException("验证码无效或已使用，请重新获取");
  }

  private async resolveWechatPhone(
    tx: Tx,
    identity: WechatIdentityResult,
    phone: string,
  ) {
    const appId = this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true });
    const subjectHash = this.crypto.hashIdentity(appId, identity.openId);
    const providedUnionIdHash = identity.unionId
      ? this.crypto.hashIdentity("unionid", identity.unionId)
      : null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-wechat:${subjectHash}`}, 0))`;
    let external = await tx.externalIdentity.findUnique({
      where: {
        provider_subjectHash: {
          provider: IdentityProvider.WECHAT_MINIAPP,
          subjectHash,
        },
      },
    });
    // WeChat may omit UnionID on a later exchange. The same authenticated OpenID
    // retains its stored cross-channel binding; absence is not a contradictory ID.
    if (
      external?.unionIdHash &&
      providedUnionIdHash &&
      external.unionIdHash !== providedUnionIdHash
    )
      throw accountLinkConflict();
    const unionIdHash = providedUnionIdHash ?? external?.unionIdHash ?? null;
    if (unionIdHash)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${unionIdHash}, 0))`;
    const union = unionIdHash
      ? await tx.wechatUnionIdentity.findUnique({ where: { unionIdHash } })
      : null;
    const unionIdEncrypted = identity.unionId
      ? this.crypto.encrypt(identity.unionId)
      : (external?.unionIdEncrypted ?? union?.unionIdEncrypted ?? null);
    if (external && union && external.userId !== union.userId)
      throw accountLinkConflict();
    const sourceId = external?.userId ?? union?.userId;
    if (sourceId) {
      const source = await tx.user.findUnique({
        where: { id: sourceId },
        select: { status: true, phoneEncrypted: true, phoneVerifiedAt: true },
      });
      if (!source || source.status !== "ACTIVE")
        throw new UnauthorizedException("账号不可用");
      if (
        source.phoneEncrypted &&
        source.phoneVerifiedAt &&
        this.crypto.decrypt(source.phoneEncrypted) !== phone
      )
        throw accountLinkConflict();
    }
    let userId = await this.phones.findOwner(tx, phone);
    // Never migrate/retire a different existing user, even an apparently empty
    // one: authenticated in-flight requests may still attach business records.
    if (userId && sourceId && sourceId !== userId) throw accountLinkConflict();
    if (
      userId &&
      sourceId !== userId &&
      (await this.phones.hasStaffAuthority(tx, userId)) &&
      !(
        this.config.get("TECHNICIAN_PHONE_LOGIN_ENABLED", { infer: true }) ===
          "true" &&
        !sourceId &&
        (await this.phones.canAttachFirstWechatToPhoneTechnician(tx, userId))
      )
    )
      throw accountLinkConflict();
    if (!userId)
      userId =
        sourceId ??
        (
          await tx.user.create({
            data: { role: UserRole.CUSTOMER, displayName: "微信用户" },
            select: { id: true },
          })
        ).id;
    const targetUnion = unionIdHash
      ? await tx.wechatUnionIdentity.findUnique({ where: { userId } })
      : null;
    if (targetUnion && targetUnion.unionIdHash !== unionIdHash)
      throw accountLinkConflict();
    if (unionIdHash && !union && !targetUnion) {
      if (!unionIdEncrypted) throw accountLinkConflict();
      await tx.wechatUnionIdentity.create({
        data: { unionIdHash, unionIdEncrypted, userId },
      });
    }
    const identityData = {
      userId,
      ...(unionIdHash && unionIdEncrypted
        ? { unionIdHash, unionIdEncrypted }
        : {}),
    };
    if (!external)
      external = await tx.externalIdentity.create({
        data: {
          provider: IdentityProvider.WECHAT_MINIAPP,
          subjectHash,
          subjectEncrypted: this.crypto.encrypt(identity.openId),
          ...identityData,
        },
      });
    else
      external = await tx.externalIdentity.update({
        where: { id: external.id },
        data: identityData,
      });
    await this.phones.register(tx, userId, phone);
    await tx.user.update({
      where: { id: userId },
      data: {
        phoneEncrypted: this.crypto.encrypt(phone),
        phoneVerifiedAt: new Date(),
      },
    });
    return { userId, identityId: external.id };
  }

  private async createSession(
    tx: Tx,
    userId: string,
    authChannel: "WECHAT_MINIAPP" | "CUSTOMER_SMS",
    authProvider: string,
    wechatIdentityId: string | null,
    customerPhoneHash?: string,
  ): Promise<AuthSession> {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { status: MembershipStatus.ACTIVE } } },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !user.phoneEncrypted ||
      !user.phoneVerifiedAt
    )
      throw new UnauthorizedException("账号不可用");
    if (
      authChannel === "CUSTOMER_SMS" &&
      (!customerPhoneHash ||
        customerPhoneHash !==
          this.phones.hash(this.crypto.decrypt(user.phoneEncrypted)))
    )
      throw accountLinkConflict();
    const accessToken = this.crypto.createSessionToken();
    const expiresAt = new Date(
      Date.now() +
        this.config.get("AUTH_SESSION_TTL_SECONDS", { infer: true }) * 1_000,
    );
    await tx.session.create({
      data: {
        userId,
        tokenHash: this.crypto.hashSessionToken(accessToken),
        expiresAt,
        authChannel,
        authProvider,
        wechatIdentityId,
        ...(authChannel === "CUSTOMER_SMS" ? { customerPhoneHash } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action:
          authChannel === "CUSTOMER_SMS"
            ? "AUTH_CUSTOMER_SMS_LOGIN"
            : "AUTH_CUSTOMER_WECHAT_PHONE_LOGIN",
        resourceType: "User",
        resourceId: userId,
        metadata: {
          channel: authChannel,
          agreementsAccepted: true,
          consentFlow: "customer-login-v1",
        },
      },
    });
    return {
      accessToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: userId,
        displayName: user.displayName,
        phoneVerified: true,
        memberships: user.memberships
          .filter(
            (membership) =>
              authChannel !== "CUSTOMER_SMS" ||
              membership.role === UserRole.CUSTOMER,
          )
          .map((membership) => ({
            organizationId: membership.organizationId,
            role: membership.role,
          })),
      },
    };
  }

  private async rateLimit(
    tx: Tx,
    scope: string,
    value: string,
    maximum: number,
    now: Date,
  ) {
    const key = this.crypto.hashPhoneVerification(
      `customer-login-rate:${scope}`,
      value,
    );
    const counter = await tx.phoneVerificationRateLimit.upsert({
      where: { key },
      create: {
        key,
        count: 1,
        expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60_000),
      },
      update: { count: { increment: 1 } },
    });
    if (counter.count > maximum)
      throw tooManyRequests("登录请求过于频繁，请稍后重试");
  }

  private hashIp(ip: string) {
    if (!ip || ip.length > 128 || /[\r\n\x00-\x1f]/.test(ip))
      throw new BadRequestException("登录请求来源无效");
    return this.crypto.hashPhoneVerification("customer-login-ip", ip);
  }

  private assertSmsEnabled() {
    if (!this.capabilities().smsLoginEnabled)
      throw configurationNotReady("短信登录尚未开通，请使用微信一键登录");
  }
  private assertAgreements(value: boolean) {
    if (value !== true)
      throw new BadRequestException(
        "请先阅读并同意用户协议、隐私政策与上门服务公约",
      );
  }
}

const safeEqual = (a: string, b: string) =>
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const tooManyRequests = (message: string) =>
  new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
const configurationNotReady = (message: string) =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: "CONFIGURATION_NOT_READY",
    message,
  });

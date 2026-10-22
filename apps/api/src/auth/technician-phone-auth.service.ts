import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MembershipStatus, Prisma, UserRole } from "@prisma/client";
import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  AuthSession,
  TechnicianPhoneLoginCapabilities,
  TechnicianPhoneSmsConfirm,
  TechnicianPhoneSmsRequest,
  TechnicianPhoneSmsRequestResult,
} from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { CustomerPhoneIdentityService } from "./customer-phone-identity.service.js";
import { withBoundedAuthTransaction } from "./bounded-auth-transaction.js";

type Tx = Prisma.TransactionClient;
const TTL = 5 * 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class TechnicianPhoneAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly phones: CustomerPhoneIdentityService,
    private readonly sms: AliyunSmsClient,
  ) {}

  capabilities(): TechnicianPhoneLoginCapabilities {
    const enabled =
      this.config.get("TECHNICIAN_PHONE_LOGIN_ENABLED", { infer: true }) ===
        "true" &&
      this.config.get("PHONE_VERIFICATION_SMS_ENABLED", { infer: true }) ===
        "true" &&
      this.config.get("SMS_PROVIDER", { infer: true }) === "aliyun" &&
      this.config.get("SMS_SEND_ENABLED", { infer: true }) === "true" &&
      this.config.get("PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT", {
        infer: true,
      }) > 0 &&
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
      enabled,
      workbenchEnabled:
        enabled &&
        this.config.get("TECHNICIAN_PHONE_WORKBENCH_ENABLED", {
          infer: true,
        }) === "true",
    };
  }

  async requestSms(
    input: TechnicianPhoneSmsRequest,
    ip: string,
  ): Promise<TechnicianPhoneSmsRequestResult> {
    this.assertEnabled(input.agreementsAccepted);
    const now = new Date();
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const code = String(randomInt(100_000, 1_000_000));
    const phoneHash = this.phones.hash(input.phone);
    const ipHash = this.hashIp(ip);
    const expiresAt = new Date(now.getTime() + TTL);
    await withBoundedAuthTransaction(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('technician-phone-global-request', 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`technician-phone-ip:${ipHash}`}, 0))`;
      await this.phones.lock(tx, input.phone);
      const recent = await tx.technicianPhoneLoginChallenge.findFirst({
        where: {
          phoneHash,
          createdAt: { gt: new Date(now.getTime() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) throw tooManyRequests("请60秒后再获取验证码");
      const hour = now.toISOString().slice(0, 13),
        day = now.toISOString().slice(0, 10);
      await this.rate(
        tx,
        "request-global-minute",
        now.toISOString().slice(0, 16),
        50,
        now,
      );
      await this.rate(tx, "request-global-hour", hour, 100, now);
      await this.rate(tx, "request-ip-hour", `${ipHash}:${hour}`, 20, now);
      await this.rate(tx, "request-phone-hour", `${phoneHash}:${hour}`, 5, now);
      await this.rate(tx, "request-phone-day", `${phoneHash}:${day}`, 10, now);
      await tx.technicianPhoneLoginChallenge.updateMany({
        where: {
          phoneHash,
          consumedAt: null,
          status: { in: ["PENDING", "ACCEPTED", "UNKNOWN"] },
        },
        data: { status: "SUPERSEDED", consumedAt: now },
      });
      await tx.technicianPhoneLoginChallenge.create({
        data: {
          id,
          phoneHash,
          phoneEncrypted: this.crypto.encrypt(input.phone),
          requestIpHash: ipHash,
          secretHash: this.hash("secret", id, secret),
          codeHash: this.hash("code", id, code),
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "AUTH_TECHNICIAN_PHONE_SMS_REQUESTED",
          resourceType: "TechnicianPhoneLoginChallenge",
          resourceId: id,
          metadata: {
            agreementsAccepted: true,
            consentFlow: "technician-phone-v1",
          },
        },
      });
    });
    // AliyunSmsClient centrally reserves the SAME chargeable daily budget as
    // customer/admin/phone verification. No automatic resends on uncertainty.
    let submission: Awaited<
      ReturnType<AliyunSmsClient["submitPhoneVerification"]>
    >;
    try {
      submission = await this.sms.submitPhoneVerification({
        phone: input.phone,
        code,
        trackingId: id,
      });
    } catch {
      await this.prisma.technicianPhoneLoginChallenge.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "REJECTED" },
      });
      throw new ServiceUnavailableException("验证码暂未发送，请稍后重试");
    }
    await this.prisma.technicianPhoneLoginChallenge.updateMany({
      where: { id, status: "PENDING", consumedAt: null },
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
      throw new ServiceUnavailableException("验证码暂未发送，请稍后重试");
    return {
      challengeId: id,
      challengeSecret: secret,
      maskedPhone: `${input.phone.slice(0, 3)}****${input.phone.slice(-4)}`,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: 60,
    };
  }

  async confirmSms(
    input: TechnicianPhoneSmsConfirm,
    ip: string,
  ): Promise<AuthSession> {
    this.assertEnabled(input.agreementsAccepted);
    const now = new Date(),
      ipHash = this.hashIp(ip);
    const result = await withBoundedAuthTransaction(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`technician-phone-confirm-ip:${ipHash}`}, 0))`;
      await this.rate(
        tx,
        "confirm-ip-hour",
        `${ipHash}:${now.toISOString().slice(0, 13)}`,
        100,
        now,
      );
      // Same lock order as resend/supersede: canonical phone, then challenge.
      // Holding challenge first would deadlock a simultaneous manual resend.
      await this.phones.lock(tx, input.phone);
      await tx.$queryRaw`SELECT "id" FROM "TechnicianPhoneLoginChallenge" WHERE "id" = ${input.challengeId} FOR UPDATE`;
      const proof = await tx.technicianPhoneLoginChallenge.findUnique({
        where: { id: input.challengeId },
      });
      if (
        !proof ||
        proof.consumedAt ||
        !["ACCEPTED", "UNKNOWN"].includes(proof.status) ||
        proof.phoneHash !== this.phones.hash(input.phone) ||
        !safeEqual(
          proof.secretHash,
          this.hash("secret", proof.id, input.challengeSecret),
        )
      )
        return { error: "INVALID" as const };
      if (proof.expiresAt <= now) {
        await tx.technicianPhoneLoginChallenge.update({
          where: { id: proof.id },
          data: { status: "EXPIRED" },
        });
        return { error: "EXPIRED" as const };
      }
      if (proof.attempts >= MAX_ATTEMPTS) return { error: "ATTEMPTS" as const };
      if (!safeEqual(proof.codeHash, this.hash("code", proof.id, input.code))) {
        await tx.technicianPhoneLoginChallenge.update({
          where: { id: proof.id },
          data: { attempts: { increment: 1 } },
        });
        return { error: "INVALID" as const };
      }
      if (this.crypto.decrypt(proof.phoneEncrypted) !== input.phone)
        return { error: "INVALID" as const };
      let userId = await this.phones.findOwner(tx, input.phone);
      if (!userId) {
        const created = await tx.user.create({
          data: {
            role: UserRole.CUSTOMER,
            displayName: "手机用户",
            phoneEncrypted: this.crypto.encrypt(input.phone),
            phoneVerifiedAt: now,
          },
          select: { id: true },
        });
        userId = created.id;
        await this.phones.register(tx, userId, input.phone);
      }
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: {
          memberships: {
            where: {
              status: MembershipStatus.ACTIVE,
              role: UserRole.THERAPIST,
            },
          },
          technicianProfile: { select: { organizationId: true, status: true } },
        },
      });
      if (
        !user ||
        user.status !== "ACTIVE" ||
        !user.phoneEncrypted ||
        !user.phoneVerifiedAt ||
        this.phones.hash(this.crypto.decrypt(user.phoneEncrypted)) !==
          proof.phoneHash
      )
        throw new UnauthorizedException("手机号绑定账号不可用");
      const consumed = await tx.technicianPhoneLoginChallenge.updateMany({
        where: {
          id: proof.id,
          consumedAt: null,
          status: { in: ["ACCEPTED", "UNKNOWN"] },
          attempts: { lt: MAX_ATTEMPTS },
          expiresAt: { gt: now },
        },
        data: { consumedAt: now, status: "CONSUMED" },
      });
      if (consumed.count !== 1)
        throw new BadRequestException("验证码无效或已经使用");
      const accessToken = this.crypto.createSessionToken();
      // Phone sessions are bounded to one day even if customer sessions last longer.
      const expiresAt = new Date(
        now.getTime() +
          Math.min(
            86_400,
            this.config.get("AUTH_SESSION_TTL_SECONDS", { infer: true }),
          ) *
            1_000,
      );
      await tx.session.create({
        data: {
          userId,
          tokenHash: this.crypto.hashSessionToken(accessToken),
          expiresAt,
          authChannel: "TECHNICIAN_PHONE",
          authProvider: "technician-sms",
          customerPhoneHash: proof.phoneHash,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: "AUTH_TECHNICIAN_PHONE_LOGIN",
          resourceType: "User",
          resourceId: userId,
          metadata: {
            channel: "TECHNICIAN_PHONE",
            consentFlow: "technician-phone-v1",
            agreementsAccepted: true,
          },
        },
      });
      const profile = user.technicianProfile;
      const memberships =
        this.capabilities().workbenchEnabled &&
        profile &&
        ["APPROVED", "PUBLISHED"].includes(profile.status)
          ? user.memberships
              .filter(
                (m) =>
                  m.role === UserRole.THERAPIST &&
                  m.organizationId === profile.organizationId,
              )
              .map((m) => ({ organizationId: m.organizationId, role: m.role }))
          : [];
      return {
        session: {
          accessToken,
          expiresAt: expiresAt.toISOString(),
          user: {
            id: user.id,
            displayName: user.displayName,
            phoneVerified: true,
            memberships,
          },
        },
      };
    });
    if (result.session) return result.session;
    if (result.error === "ATTEMPTS")
      throw tooManyRequests("验证码尝试次数过多，请重新获取");
    throw new BadRequestException(
      result.error === "EXPIRED"
        ? "验证码已过期，请重新获取"
        : "验证码无效或已使用，请重新获取",
    );
  }

  private assertEnabled(accepted: boolean) {
    if (accepted !== true)
      throw new BadRequestException("请先阅读并同意技师入驻协议与隐私政策");
    if (!this.capabilities().enabled)
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "CONFIGURATION_NOT_READY",
        message: "技师手机号入驻尚未开放，请联系平台",
      });
  }
  private hash(kind: string, id: string, value: string) {
    return this.crypto.hashPhoneVerification(
      `technician-phone-login:${kind}`,
      `${id}:${value}`,
    );
  }
  private hashIp(ip: string) {
    if (!ip || ip.length > 128 || /[\r\n\x00-\x1f]/.test(ip))
      throw new BadRequestException("登录请求来源无效");
    return this.crypto.hashPhoneVerification("technician-phone-login:ip", ip);
  }
  private async rate(
    tx: Tx,
    scope: string,
    value: string,
    max: number,
    now: Date,
  ) {
    const key = this.crypto.hashPhoneVerification(
      `technician-phone-login:rate:${scope}`,
      value,
    );
    const row = await tx.phoneVerificationRateLimit.upsert({
      where: { key },
      create: {
        key,
        count: 1,
        expiresAt: new Date(now.getTime() + 2 * 86_400_000),
      },
      update: { count: { increment: 1 } },
    });
    if (row.count > max) throw tooManyRequests("请求过于频繁，请稍后重试");
  }
}
const safeEqual = (a: string, b: string) =>
  /^[0-9a-f]{64}$/.test(a) &&
  /^[0-9a-f]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const tooManyRequests = (message: string) =>
  new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);

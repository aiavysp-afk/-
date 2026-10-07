import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  SmsPhoneVerificationConfirm,
  SmsPhoneVerificationRequest,
  SmsPhoneVerificationRequestResult,
  WechatPhoneVerificationResult,
} from "@zydj/contracts";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const RESEND_COOLDOWN_MS = 60 * 1_000;
const USER_HOURLY_LIMIT = 5;
const PHONE_DAILY_LIMIT = 10;
const MAX_ATTEMPTS = 5;

@Injectable()
export class PhoneVerificationSmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly sms: AliyunSmsClient,
  ) {}

  async request(
    principal: AuthPrincipal,
    input: SmsPhoneVerificationRequest,
  ): Promise<SmsPhoneVerificationRequestResult> {
    const now = new Date();
    const challengeId = randomUUID();
    const code = String(randomInt(100_000, 1_000_000));
    const phoneHash = this.crypto.hashPhoneVerification("phone", input.phone);
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { phoneVerifiedAt: true },
      });
      if (user.phoneVerifiedAt)
        throw new ConflictException("手机号已经完成验证，如需更换请联系人工客服");

      const recent = await tx.phoneVerificationChallenge.findFirst({
        where: {
          userId: principal.userId,
          phoneHash,
          consumedAt: null,
          status: { in: ["PENDING", "ACCEPTED", "UNKNOWN"] },
          createdAt: {
            gt: new Date(now.getTime() - RESEND_COOLDOWN_MS),
          },
        },
        select: { id: true },
      });
      if (recent) throw tooManyRequests("请稍后再获取验证码");

      const hour = now.toISOString().slice(0, 13);
      const day = now.toISOString().slice(0, 10);
      const userLimit = await tx.phoneVerificationRateLimit.upsert({
        where: {
          key: this.crypto.hashPhoneVerification(
            "rate-user-hour",
            `${principal.userId}:${hour}`,
          ),
        },
        create: {
          key: this.crypto.hashPhoneVerification(
            "rate-user-hour",
            `${principal.userId}:${hour}`,
          ),
          count: 1,
          expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
        },
        update: { count: { increment: 1 } },
      });
      const phoneLimit = await tx.phoneVerificationRateLimit.upsert({
        where: {
          key: this.crypto.hashPhoneVerification(
            "rate-phone-day",
            `${phoneHash}:${day}`,
          ),
        },
        create: {
          key: this.crypto.hashPhoneVerification(
            "rate-phone-day",
            `${phoneHash}:${day}`,
          ),
          count: 1,
          expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000),
        },
        update: { count: { increment: 1 } },
      });
      if (
        userLimit.count > USER_HOURLY_LIMIT ||
        phoneLimit.count > PHONE_DAILY_LIMIT
      )
        throw tooManyRequests("验证码请求过于频繁，请稍后再试");

      await tx.phoneVerificationChallenge.create({
        data: {
          id: challengeId,
          userId: principal.userId,
          phoneHash,
          phoneEncrypted: this.crypto.encrypt(input.phone),
          codeHash: this.crypto.hashPhoneVerification(
            "code",
            `${challengeId}:${code}`,
          ),
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_SMS_PHONE_CODE_REQUESTED",
          resourceType: "PhoneVerificationChallenge",
          resourceId: challengeId,
          metadata: { channel: "ALIYUN_SMS" },
        },
      });
    });

    let submission: Awaited<ReturnType<AliyunSmsClient["submitPhoneVerification"]>>;
    try {
      submission = await this.sms.submitPhoneVerification({
        phone: input.phone,
        code,
        trackingId: challengeId,
      });
    } catch (error) {
      await this.prisma.phoneVerificationChallenge.updateMany({
        where: { id: challengeId, status: "PENDING" },
        data: { status: "REJECTED" },
      });
      throw error;
    }

    await this.prisma.phoneVerificationChallenge.update({
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

    return {
      status: submission.status,
      expiresAt: expiresAt.toISOString(),
      retryAfterSeconds: RESEND_COOLDOWN_MS / 1_000,
    };
  }

  async confirm(
    principal: AuthPrincipal,
    input: SmsPhoneVerificationConfirm,
  ): Promise<WechatPhoneVerificationResult> {
    const currentUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { phoneEncrypted: true, phoneVerifiedAt: true },
    });
    if (currentUser.phoneVerifiedAt && currentUser.phoneEncrypted) {
      const currentPhone = this.crypto.decrypt(currentUser.phoneEncrypted);
      if (currentPhone === input.phone) return verifiedResult(currentPhone);
      throw new ConflictException("手机号已经完成验证，如需更换请联系人工客服");
    }

    const now = new Date();
    const phoneHash = this.crypto.hashPhoneVerification("phone", input.phone);
    const challenge = await this.prisma.phoneVerificationChallenge.findFirst({
      where: {
        userId: principal.userId,
        phoneHash,
        consumedAt: null,
        status: { in: ["ACCEPTED", "UNKNOWN"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge) throw new BadRequestException("请先获取短信验证码");
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.phoneVerificationChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("验证码已过期，请重新获取");
    }
    if (challenge.attempts >= MAX_ATTEMPTS)
      throw tooManyRequests("验证码尝试次数过多，请重新获取");

    const candidate = this.crypto.hashPhoneVerification(
      "code",
      `${challenge.id}:${input.code}`,
    );
    const valid = timingSafeEqual(
      Buffer.from(challenge.codeHash, "hex"),
      Buffer.from(candidate, "hex"),
    );
    if (!valid) {
      await this.prisma.phoneVerificationChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          attempts: { lt: MAX_ATTEMPTS },
        },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("验证码不正确");
    }

    const phoneEncrypted = this.crypto.encrypt(input.phone);
    await this.prisma.$transaction(async (tx) => {
      const userUpdate = await tx.user.updateMany({
        where: { id: principal.userId, phoneVerifiedAt: null },
        data: { phoneEncrypted, phoneVerifiedAt: now },
      });
      if (userUpdate.count !== 1)
        throw new ConflictException("手机号验证状态已变更，请刷新后重试");
      const challengeUpdate = await tx.phoneVerificationChallenge.updateMany({
        where: {
          id: challenge.id,
          userId: principal.userId,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: MAX_ATTEMPTS },
          status: { in: ["ACCEPTED", "UNKNOWN"] },
        },
        data: { status: "CONSUMED", consumedAt: now },
      });
      if (challengeUpdate.count !== 1)
        throw new ConflictException("验证码已经使用或失效");
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_SMS_PHONE_VERIFIED",
          resourceType: "User",
          resourceId: principal.userId,
          metadata: { channel: "ALIYUN_SMS" },
        },
      });
    });
    return verifiedResult(input.phone);
  }
}

const verifiedResult = (phone: string): WechatPhoneVerificationResult => ({
  phoneVerified: true,
  maskedPhone: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
});

const tooManyRequests = (message: string) =>
  new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);

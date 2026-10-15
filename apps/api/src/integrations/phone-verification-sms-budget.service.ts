import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { withBoundedAuthTransaction } from "../auth/bounded-auth-transaction.js";

const businessDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function phoneVerificationSmsDay(now: Date): string {
  const parts = businessDay.formatToParts(now);
  return ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)!.value)
    .join("-");
}

@Injectable()
export class PhoneVerificationSmsBudgetService {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {}

  // A reservation counts an outbound attempt, not delivery or provider billing
  // segments. Never refund UNKNOWN/timeout/rejection and never retry here.
  async reserve(now = new Date()): Promise<void> {
    const maximum = this.config.get(
      "PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT",
      { infer: true },
    );
    if (
      this.config.get("SMS_PROVIDER", { infer: true }) !== "aliyun" ||
      this.config.get("SMS_SEND_ENABLED", { infer: true }) !== "true" ||
      this.config.get("PHONE_VERIFICATION_SMS_ENABLED", { infer: true }) !==
        "true" ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 10_000
    )
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "CONFIGURATION_NOT_READY",
        message: "短信发送额度尚未配置，请使用微信登录",
      });

    // Shared by customer login, existing phone binding and staff password SMS.
    // This namespace cannot collide with the existing HMAC per-user/IP keys.
    const key = `verification-sms-request-budget:${phoneVerificationSmsDay(now)}`;
    try {
      await withBoundedAuthTransaction(this.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const counter = await tx.phoneVerificationRateLimit.upsert({
          where: { key },
          create: {
            key,
            count: 1,
            expiresAt: new Date(now.getTime() + 2 * 86_400_000),
          },
          update: { count: { increment: 1 } },
        });
        // Throw inside the transaction so an over-limit increment rolls back.
        if (counter.count > maximum)
          throw new HttpException(
            {
              statusCode: 429,
              code: "SMS_DAILY_REQUEST_LIMIT",
              message: "短信请求已达当日上限，请使用微信登录",
            },
            429,
          );
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429)
        throw error;
      // Database failure or an uncertain commit must stop before provider I/O.
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "SMS_BUDGET_UNAVAILABLE",
        message: "短信服务暂不可用，请使用微信登录或稍后重试",
      });
    }
  }
}

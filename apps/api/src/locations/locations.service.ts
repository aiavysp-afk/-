import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, ReservationStatus } from "@prisma/client";
import type { OrderCreate } from "@zydj/contracts";
import { createHash, createHmac } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { TencentMapClient } from "../integrations/tencent-map.client.js";

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: TencentMapClient,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private rateKey(scope: string, subject: string, bucket: number) {
    return createHash("sha256")
      .update(`map:${scope}:${subject}:${bucket}`)
      .digest("hex");
  }

  private assertEnabled() {
    if (
      this.config.get("MAP_PROVIDER", { infer: true }) !== "tencent" ||
      this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("地址搜索与核验尚未开放");
  }

  private allowedAdcodes() {
    return new Set(
      this.config
        .get("SERVICE_AREA_ADCODE_ALLOWLIST", { infer: true })
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  private detailHash(userId: string, reservationId: string, detail: string) {
    return createHmac(
      "sha256",
      this.config.get("AUTH_SESSION_PEPPER", { infer: true }),
    )
      .update(`${userId}\0${reservationId}\0${detail.trim()}`)
      .digest("hex");
  }

  private async take(
    scope: string,
    subject: string,
    limit: number,
    windowMs: number,
    now: Date,
  ) {
    const bucket = Math.floor(now.getTime() / windowMs);
    const row = await this.prisma.mapRequestRateLimit.upsert({
      where: { key: this.rateKey(scope, subject, bucket) },
      create: {
        key: this.rateKey(scope, subject, bucket),
        count: 1,
        expiresAt: new Date((bucket + 2) * windowMs),
      },
      update: { count: { increment: 1 } },
    });
    if (row.count > limit)
      throw new HttpException("地址搜索过于频繁，请稍后重试", 429);
  }

  async suggest(principal: AuthPrincipal, keyword: string, now = new Date()) {
    this.assertEnabled();
    // Durable per-user and global budgets prevent one session or a burst across
    // API replicas from turning this authenticated endpoint into a paid proxy.
    await this.take("user-minute", principal.userId, 12, 60_000, now);
    await this.take("user-day", principal.userId, 120, 86_400_000, now);
    await this.take("global-minute", "all", 240, 60_000, now);
    await this.take("global-day", "all", 5_000, 86_400_000, now);
    await this.prisma.mapRequestRateLimit.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return this.maps.suggest({
      keyword,
      // The caller cannot broaden provider queries outside the configured city.
      city: this.config.get("SERVICE_CITY", { infer: true }),
    });
  }

  async verify(
    principal: AuthPrincipal,
    input: { reservationId: string; detail: string },
    now = new Date(),
  ) {
    this.assertEnabled();
    const reservation = await this.prisma.appointmentReservation.findUnique({
      where: { id: input.reservationId },
    });
    if (!reservation) throw new NotFoundException("预约占位不存在");
    if (reservation.customerId !== principal.userId)
      throw new ForbiddenException("不能核验其他用户的预约地址");
    if (
      reservation.status !== ReservationStatus.HOLD ||
      reservation.expiresAt <= now
    )
      throw new ConflictException("预约占位已结束或过期");

    const detailHash = this.detailHash(
      principal.userId,
      reservation.id,
      input.detail,
    );
    const allowed = this.allowedAdcodes();
    const existing = await this.prisma.addressVerification.findUnique({
      where: { reservationId: reservation.id },
    });
    if (
      existing?.userId === principal.userId &&
      existing.detailHash === detailHash &&
      existing.expiresAt > now &&
      allowed.has(existing.adcode)
    )
      return this.toVerification(existing);

    await this.take(
      "verification-user-minute",
      principal.userId,
      4,
      60_000,
      now,
    );
    await this.take(
      "verification-user-day",
      principal.userId,
      30,
      86_400_000,
      now,
    );
    await this.take("verification-global-minute", "all", 120, 60_000, now);
    await this.take("verification-global-day", "all", 2_000, 86_400_000, now);
    const result = await this.maps.geocode({
      address: input.detail,
      city: this.config.get("SERVICE_CITY", { infer: true }),
    });
    if (result.requiresManualConfirmation)
      throw new UnprocessableEntityException(
        "地址精度不足，请补充楼栋门牌后重新核验",
      );
    if (!allowed.has(result.adcode))
      throw new UnprocessableEntityException("该地址暂不在已配置服务范围内");

    const verification = await this.prisma.addressVerification.upsert({
      where: { reservationId: reservation.id },
      create: {
        userId: principal.userId,
        reservationId: reservation.id,
        detailHash,
        adcode: result.adcode,
        expiresAt: reservation.expiresAt,
      },
      update: {
        userId: principal.userId,
        detailHash,
        adcode: result.adcode,
        expiresAt: reservation.expiresAt,
      },
    });
    await this.prisma.addressVerification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return this.toVerification(verification);
  }

  async assertOrderVerification(
    tx: Prisma.TransactionClient,
    principal: AuthPrincipal,
    input: OrderCreate,
    now: Date,
  ) {
    if (
      this.config.get("MAP_PROVIDER", { infer: true }) !== "tencent" ||
      this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) !== "true"
    )
      return;
    if (!input.addressVerificationId)
      throw new UnprocessableEntityException("请先完成服务地址核验");
    const row = await tx.addressVerification.findUnique({
      where: { id: input.addressVerificationId },
    });
    const expectedHash = this.detailHash(
      principal.userId,
      input.reservationId,
      input.address.detail,
    );
    if (
      !row ||
      row.userId !== principal.userId ||
      row.reservationId !== input.reservationId ||
      row.detailHash !== expectedHash ||
      row.expiresAt <= now ||
      !this.allowedAdcodes().has(row.adcode)
    )
      throw new UnprocessableEntityException("服务地址核验已失效，请重新核验");
  }

  private toVerification(row: {
    id: string;
    reservationId: string;
    adcode: string;
    expiresAt: Date;
  }) {
    return {
      id: row.id,
      reservationId: row.reservationId,
      adcode: row.adcode,
      expiresAt: row.expiresAt.toISOString(),
    };
  }
}

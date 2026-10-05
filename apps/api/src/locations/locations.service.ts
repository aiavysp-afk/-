import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
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
      .update(`map-address-suggestion:${scope}:${subject}:${bucket}`)
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
    if (
      this.config.get("MAP_PROVIDER", { infer: true }) !== "tencent" ||
      this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("地址搜索尚未开放");
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
}

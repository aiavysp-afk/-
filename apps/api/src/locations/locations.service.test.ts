import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { validateEnv, type AppEnv } from "../config/env.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { TencentMapClient } from "../integrations/tencent-map.client.js";
import { LocationsService } from "./locations.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "customer-1",
  displayName: "Customer",
  memberships: [],
};

function harness(overrides: Record<string, string> = {}) {
  const counters = new Map<string, number>();
  const prisma = {
    mapRequestRateLimit: {
      upsert: vi.fn(async ({ where }: { where: { key: string } }) => {
        const count = (counters.get(where.key) ?? 0) + 1;
        counters.set(where.key, count);
        return { key: where.key, count, expiresAt: new Date() };
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
  const maps = {
    suggest: vi.fn().mockResolvedValue([
      {
        id: "poi-1",
        title: "测试楼宇",
        address: "中原区测试路1号",
        city: "郑州市",
        adcode: "410102",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      },
    ]),
  } as unknown as TencentMapClient;
  const config = new ConfigService<AppEnv, true>(
    validateEnv({
      MAP_PROVIDER: "tencent",
      MAP_GEOCODING_ENABLED: "true",
      SERVICE_CITY: "郑州市",
      ...overrides,
    }),
  );
  return {
    service: new LocationsService(prisma, maps, config),
    prisma,
    maps,
  };
}

describe("LocationsService", () => {
  it("uses the server-side service city without exposing provider credentials", async () => {
    const { service, maps, prisma } = harness();
    const result = await service.suggest(
      principal,
      "中原",
      new Date("2026-10-05T10:00:00.000Z"),
    );
    expect(result).toHaveLength(1);
    expect(maps.suggest).toHaveBeenCalledWith({
      keyword: "中原",
      city: "郑州市",
    });
    expect(prisma.mapRequestRateLimit.upsert).toHaveBeenCalledTimes(4);
  });

  it("fails closed before database or provider access when the feature gate is off", async () => {
    const { service, maps, prisma } = harness({
      MAP_GEOCODING_ENABLED: "false",
    });
    await expect(service.suggest(principal, "中原")).rejects.toThrow(
      "尚未开放",
    );
    expect(prisma.mapRequestRateLimit.upsert).not.toHaveBeenCalled();
    expect(maps.suggest).not.toHaveBeenCalled();
  });

  it("enforces a durable per-user minute limit before spending global budget", async () => {
    const { service, maps, prisma } = harness();
    const now = new Date("2026-10-05T10:00:00.000Z");
    for (let index = 0; index < 12; index += 1)
      await service.suggest(principal, "中原", now);
    await expect(
      service.suggest(principal, "中原", now),
    ).rejects.toBeInstanceOf(HttpException);
    expect(maps.suggest).toHaveBeenCalledTimes(12);
    expect(prisma.mapRequestRateLimit.upsert).toHaveBeenCalledTimes(49);
  });
});

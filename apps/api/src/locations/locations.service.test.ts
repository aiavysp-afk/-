import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { validateEnv, type AppEnv } from "../config/env.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AmapClient } from "../integrations/amap.client.js";
import { LocationsService } from "./locations.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "customer-1",
  displayName: "Customer",
  memberships: [],
};
const coordinate = {
  latitude: 34.75,
  longitude: 113.65,
  coordinateSystem: "GCJ-02" as const,
};

function harness(overrides: Record<string, string> = {}) {
  const counters = new Map<string, number>();
  const expiresAt = new Date("2026-10-05T10:10:00.000Z");
  const prismaMock = {
    mapRequestRateLimit: {
      upsert: vi.fn(async ({ where }: { where: { key: string } }) => {
        const count = (counters.get(where.key) ?? 0) + 1;
        counters.set(where.key, count);
        return { key: where.key, count, expiresAt: new Date() };
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentReservation: {
      findUnique: vi.fn().mockResolvedValue({
        id: "reservation-1",
        customerId: principal.userId,
        status: "HOLD",
        expiresAt,
      }),
    },
    addressVerification: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi
        .fn()
        .mockImplementation(({ create }: { create: object }) =>
          Promise.resolve({ id: "verification-1", ...create }),
        ),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = prismaMock as unknown as PrismaService;
  const mapsMock = {
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
    reverseGeocode: vi.fn().mockResolvedValue({
      ...coordinate,
      adcode: "410102",
      formattedAddress: "河南省郑州市中原区测试路1号",
    }),
  };
  const maps = mapsMock as unknown as AmapClient;
  const config = new ConfigService<AppEnv, true>(
    validateEnv({
      MAP_PROVIDER: "amap",
      MAP_GEOCODING_ENABLED: "true",
      SERVICE_CITY: "郑州市",
      SERVICE_AREA_ADCODE_ALLOWLIST: "410102",
      AMAP_MINIAPP_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      AMAP_WEB_SERVICE_KEY: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ...overrides,
    }),
  );
  return {
    service: new LocationsService(prisma, maps, config),
    prisma,
    prismaMock,
    maps,
    mapsMock,
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

  it("stores only a keyed address digest and bounded district verification", async () => {
    const { service, prismaMock, mapsMock } = harness();
    const now = new Date("2026-10-05T10:00:00.000Z");
    await expect(
      service.verify(
        principal,
        {
          reservationId: "reservation-1",
          detail: "郑州市中原区测试路1号A座",
          ...coordinate,
        },
        now,
      ),
    ).resolves.toEqual({
      id: "verification-1",
      reservationId: "reservation-1",
      adcode: "410102",
      ...coordinate,
      expiresAt: "2026-10-05T10:10:00.000Z",
    });
    expect(mapsMock.reverseGeocode).toHaveBeenCalledWith({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    });
    const create =
      prismaMock.addressVerification.upsert.mock.calls[0]![0].create;
    expect(create.detailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create).not.toHaveProperty("detail");
    expect(create).toMatchObject(coordinate);
  });

  it("rejects other users and out-of-area coordinates before issuing a usable proof", async () => {
    const foreign = harness();
    foreign.prismaMock.appointmentReservation.findUnique.mockResolvedValue({
      id: "reservation-1",
      customerId: "another-user",
      status: "HOLD",
      expiresAt: new Date("2026-10-05T10:10:00.000Z"),
    });
    await expect(
      foreign.service.verify(principal, {
        reservationId: "reservation-1",
        detail: "郑州市中原区测试路1号A座",
        ...coordinate,
      }),
    ).rejects.toThrow("其他用户");
    expect(foreign.mapsMock.reverseGeocode).not.toHaveBeenCalled();

    const outside = harness();
    outside.mapsMock.reverseGeocode.mockResolvedValue({
      ...coordinate,
      adcode: "110101",
      formattedAddress: "河南省郑州市边界外测试点",
    });
    await expect(
      outside.service.verify(
        principal,
        {
          reservationId: "reservation-1",
          detail: "北京市东城区测试地址1号",
          ...coordinate,
        },
        new Date("2026-10-05T10:00:00.000Z"),
      ),
    ).rejects.toThrow("不在已配置服务范围");
  });

  it("binds order proofs to the user, reservation, exact address and current allowlist", async () => {
    const { service, prismaMock } = harness();
    const now = new Date("2026-10-05T10:00:00.000Z");
    await service.verify(
      principal,
      {
        reservationId: "reservation-1",
        detail: "郑州市中原区测试路1号A座",
        ...coordinate,
      },
      now,
    );
    const created =
      prismaMock.addressVerification.upsert.mock.calls[0]![0].create;
    const tx = {
      addressVerification: {
        findUnique: vi.fn().mockResolvedValue({
          id: "verification-1",
          ...created,
        }),
      },
    };
    const input = {
      reservationId: "reservation-1",
      addressVerificationId: "verification-1",
      address: {
        contactName: "林女士",
        phone: "13800138000",
        detail: "郑州市中原区测试路1号A座",
        ...coordinate,
      },
    };
    await expect(
      service.assertOrderVerification(tx as never, principal, input, now),
    ).resolves.toBeUndefined();
    await expect(
      service.assertOrderVerification(
        tx as never,
        principal,
        {
          ...input,
          address: { ...input.address, detail: "郑州市其他地址2号" },
        },
        now,
      ),
    ).rejects.toThrow("已失效");
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

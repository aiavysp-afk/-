import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { LocationsController } from "./locations.controller.js";
import { LocationsService } from "./locations.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-location-http",
  userId: "customer-1",
  displayName: "Customer",
  memberships: [],
};
const service = {
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
  verify: vi.fn().mockResolvedValue({
    id: "verification-1",
    reservationId: "reservation-1",
    adcode: "410102",
    expiresAt: "2026-10-05T10:10:00.000Z",
  }),
};

@Module({
  controllers: [LocationsController],
  providers: [
    { provide: LocationsService, useValue: service },
    {
      provide: AuthService,
      useValue: { authenticate: vi.fn().mockResolvedValue(principal) },
    },
    SessionAuthGuard,
  ],
})
class TestModule {}

describe("Locations HTTP boundary", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    Object.assign(app.get(SessionAuthGuard), {
      auth: { authenticate: vi.fn().mockResolvedValue(principal) },
    });
    Object.assign(app.get(LocationsController), { locations: service });
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app?.close());

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/locations/address-suggestions?keyword=中原",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects missing, short, or extra query parameters", async () => {
    for (const url of [
      "/v1/locations/address-suggestions",
      "/v1/locations/address-suggestions?keyword=a",
      "/v1/locations/address-suggestions?keyword=中原&city=北京",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer test" },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.suggest).not.toHaveBeenCalled();
  });

  it("routes a bounded keyword under the authenticated identity", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/locations/address-suggestions?keyword=%E4%B8%AD%E5%8E%9F",
      headers: { authorization: "Bearer test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(1);
    expect(service.suggest).toHaveBeenCalledWith(principal, "中原");
  });

  it("requires a strict reservation-bound address verification body", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/locations/address-verifications",
      headers: { authorization: "Bearer test" },
      payload: {
        reservationId: "reservation-1",
        detail: "郑州市中原区测试路1号",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
        adcode: "110101",
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    const valid = await app.inject({
      method: "POST",
      url: "/v1/locations/address-verifications",
      headers: { authorization: "Bearer test" },
      payload: {
        reservationId: "reservation-1",
        detail: "郑州市中原区测试路1号",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().data.adcode).toBe("410102");
    expect(service.verify).toHaveBeenCalledWith(principal, {
      reservationId: "reservation-1",
      detail: "郑州市中原区测试路1号",
      latitude: 34.75,
      longitude: 113.65,
      coordinateSystem: "GCJ-02",
    });
  });
});

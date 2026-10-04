import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SafetyController } from "./safety.controller.js";
import { SafetyService } from "./safety.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-safety-http",
  userId: "customer-1",
  displayName: "Customer",
  memberships: [],
};
const incident = {
  id: "incident-1",
  organizationId: "org-1",
  orderId: "order-1",
  category: "PERSONAL_SAFETY",
  status: "OPEN",
  acknowledgementDueAt: "2026-10-05T03:00:00.000Z",
  acknowledgedById: null,
  acknowledgedAt: null,
  escalatedAt: null,
  resolutionCode: null,
  closedAt: null,
  createdAt: "2026-10-05T02:58:00.000Z",
};
const service = {
  configureRoster: vi.fn(),
  getActiveRoster: vi.fn(),
  createIncident: vi.fn().mockResolvedValue({
    data: incident,
    idempotentReplay: false,
  }),
  listOwn: vi.fn().mockResolvedValue([incident]),
  listStaff: vi.fn(),
  acknowledge: vi.fn().mockResolvedValue({
    ...incident,
    status: "ACKNOWLEDGED",
  }),
  close: vi.fn(),
};

@Module({
  controllers: [SafetyController],
  providers: [
    { provide: SafetyService, useValue: service },
    {
      provide: AuthService,
      useValue: {
        authenticate: vi.fn().mockResolvedValue(principal),
      },
    },
    SessionAuthGuard,
  ],
})
class TestModule {}

describe("Safety HTTP boundary", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    // Vitest's transform does not emit Nest constructor metadata in this
    // isolated module, so wire the two already-registered test doubles.
    Object.assign(app.get(SessionAuthGuard), {
      auth: { authenticate: vi.fn().mockResolvedValue(principal) },
    });
    Object.assign(app.get(SafetyController), { safety: service });
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/orders/order-1/safety-incidents",
    });
    expect(response.statusCode).toBe(401);
  });

  it("requires a bounded idempotency key and strict category", async () => {
    for (const request of [
      {
        headers: { authorization: "Bearer test" },
        payload: { category: "PERSONAL_SAFETY" },
      },
      {
        headers: {
          authorization: "Bearer test",
          "idempotency-key": "safety-incident-key-0001",
        },
        payload: { category: "PERSONAL_SAFETY", note: "free text" },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/orders/order-1/safety-incidents",
        ...request,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.createIncident).not.toHaveBeenCalled();
  });

  it("routes a valid customer incident without exposing responder ids", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders/order-1/safety-incidents",
      headers: {
        authorization: "Bearer test",
        "idempotency-key": "safety-incident-key-0001",
      },
      payload: { category: "PERSONAL_SAFETY" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: incident,
      meta: { idempotentReplay: false },
    });
    expect(response.json().data).not.toHaveProperty("primaryUserId");
    expect(service.createIncident).toHaveBeenCalledWith(
      principal,
      "order-1",
      { category: "PERSONAL_SAFETY" },
      "safety-incident-key-0001",
    );
  });

  it("rejects arbitrary close outcomes before calling the service", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/organizations/org-1/safety-incidents/incident-1/close",
      headers: { authorization: "Bearer test" },
      payload: { resolutionCode: "CUSTOM_NOTE" },
    });
    expect(response.statusCode).toBe(400);
    expect(service.close).not.toHaveBeenCalled();
  });
});

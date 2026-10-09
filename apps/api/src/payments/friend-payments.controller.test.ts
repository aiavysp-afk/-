import "reflect-metadata";
import { Module, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { FriendPaymentsController } from "./friend-payments.controller.js";
import { FriendPaymentsService } from "./friend-payments.service.js";
const service = {
  createShare: vi.fn(async () => ({})),
  summary: vi.fn(async () => ({})),
  createIntent: vi.fn(async () => ({})),
  readIntent: vi.fn(async () => ({})),
  reconcile: vi.fn(async () => ({})),
  notifications: vi.fn(async () => []),
};
const principal = {
  userId: "customer",
  sessionId: "session",
  displayName: "客户",
  memberships: [],
};
const mockAuthenticate = async (context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest();
  if (req.headers.authorization !== "Bearer test-session")
    throw new UnauthorizedException();
  req.authPrincipal = principal;
  return true;
};
@Module({
  controllers: [FriendPaymentsController],
  providers: [
    { provide: FriendPaymentsService, useValue: service },
    {
      provide: SessionAuthGuard,
      useValue: {
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== "Bearer test-session")
            throw new UnauthorizedException();
          req.authPrincipal = principal;
          return true;
        },
      },
    },
  ],
})
class TestModule {}
const token = "A".repeat(43);
const endpoints = [
  ["POST", "/v1/orders/order/friend-payment", "createShare", "order"],
  ["GET", `/v1/friend-payments/${token}`, "summary", token],
  [
    "POST",
    `/v1/friend-payments/${token}/payment-intent`,
    "createIntent",
    token,
  ],
  ["GET", `/v1/friend-payments/${token}/payment-intent`, "readIntent", token],
  ["POST", `/v1/friend-payments/${token}/reconcile`, "reconcile", token],
  ["GET", "/v1/payments/notifications", "notifications", null],
] as const;
describe("friend payment HTTP session boundary", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    // Vitest/esbuild omits constructor metadata for class-level enhancer instances; authenticate through an explicit test spy.
    vi.spyOn(SessionAuthGuard.prototype, "canActivate").mockImplementation(
      mockAuthenticate,
    );
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });
  it.each(endpoints)(
    "requires authentication for %s %s",
    async (method, url, name) => {
      service[name].mockClear();
      const response = await app.inject({
        method,
        url,
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(service[name]).not.toHaveBeenCalled();
    },
  );
  it.each(endpoints)(
    "passes only server authenticated identity through %s %s",
    async (method, url, name, value) => {
      service[name].mockClear();
      const response = await app.inject({
        method,
        url,
        headers: { authorization: "Bearer test-session" },
        ...(method === "POST"
          ? {
              payload: {
                payerUserId: "forged",
                customerId: "forged",
                amountFen: 1,
                openid: "forged",
              },
            }
          : {}),
      });
      expect(response.statusCode).toBe(method === "POST" ? 201 : 200);
      expect(service[name]).toHaveBeenCalledWith(
        ...(value ? [principal, value] : [principal]),
      );
    },
  );
});

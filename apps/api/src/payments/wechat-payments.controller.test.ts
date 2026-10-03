import "reflect-metadata";
import { Module, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { WechatPaymentsController } from "./wechat-payments.controller.js";
import { WechatPaymentsService } from "./wechat-payments.service.js";
import { WechatRecoveryService } from "./wechat-recovery.service.js";

const service = {
  notify: vi.fn().mockResolvedValue({ duplicate: false }),
  reconcile: vi.fn(),
};
@Module({
  controllers: [WechatPaymentsController],
  providers: [
    { provide: WechatPaymentsService, useValue: service },
    { provide: WechatRecoveryService, useValue: { closeOwnOrder: vi.fn() } },
    {
      provide: SessionAuthGuard,
      useValue: {
        canActivate: () => {
          throw new UnauthorizedException();
        },
      },
    },
  ],
})
class TestModule {}

describe("Wechat notification HTTP boundary", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { rawBody: true, logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("passes exact original bytes through the actual Fastify JSON parser and returns empty 204", async () => {
    const payload = '{\n  "test": "原始通知"\n}';
    const response = await app.inject({
      method: "POST",
      url: "/v1/payments/wechat/notify",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(service.notify.mock.calls[0]![0]).toEqual(Buffer.from(payload));
  });
  it("returns failure and no acknowledgment for rejected signatures", async () => {
    service.notify.mockRejectedValueOnce(
      new UnauthorizedException("internal test detail"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/payments/wechat/notify",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "FAIL",
      message: "通知未处理，请重试",
    });
  });
  it("requires a session for the customer reconciliation route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/payments/payment-1/reconcile",
    });
    expect(response.statusCode).toBe(401);
    expect(service.reconcile).not.toHaveBeenCalled();
  });
  it("requires a session for original-order cancellation", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/payments/orders/order-1/close",
        })
      ).statusCode,
    ).toBe(401);
  });
});

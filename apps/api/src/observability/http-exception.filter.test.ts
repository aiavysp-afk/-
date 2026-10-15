import { BadRequestException, HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { HttpExceptionTelemetryFilter } from "./http-exception.filter.js";

function harness(url = "/v1/orders?token=secret") {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const error = vi.fn();
  const request = {
    id: "req-1",
    method: "POST",
    url,
    log: { error },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ status }),
    }),
  };
  return { host, status, send, error };
}

describe("HttpExceptionTelemetryFilter", () => {
  it("logs route metadata without query strings or request bodies", () => {
    const { host, status, send, error } = harness();
    new HttpExceptionTelemetryFilter().catch(
      new BadRequestException("订单参数无效"),
      host as never,
    );

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "http_exception",
        requestId: "req-1",
        path: "/v1/orders",
        statusCode: 400,
      }),
      "request failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("token=secret");
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "订单参数无效" }),
    );
  });

  it("does not expose unexpected exception messages", () => {
    const { host, status, send } = harness();
    new HttpExceptionTelemetryFilter().catch(
      new Error("database password leaked"),
      host as never,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      statusCode: 500,
      message: "服务暂时不可用，请稍后重试",
    });
  });
  it.each([
    "SMS_DAILY_REQUEST_LIMIT",
    "SMS_BUDGET_UNAVAILABLE",
    "CONFIGURATION_NOT_READY",
    "LOGIN_BUSY",
    "ACCOUNT_LINK_CONFLICT",
  ])(
    "logs the safe response code %s without response message/details",
    (code) => {
      const { host, status, send, error } = harness();
      const response = {
        statusCode: 503,
        code,
        message: "synthetic-private-phone-13800138000",
        detail: "synthetic-private-password",
      };
      new HttpExceptionTelemetryFilter().catch(
        new HttpException(response, 503),
        host as never,
      );
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: code, statusCode: 503 }),
        "request failed",
      );
      expect(JSON.stringify(error.mock.calls)).not.toMatch(
        /synthetic-private|13800138000|password/,
      );
      expect(status).toHaveBeenCalledWith(503);
      expect(send).toHaveBeenCalledWith(response); // no business response changes
    },
  );
  it.each([
    "13800138000",
    "123456",
    "PRIVATE_UPPERCASE_SECRET",
    "SMS_BUDGET_UNAVAILABLE\n",
    { secret: "private" },
    ["SMS_BUDGET_UNAVAILABLE"],
  ])(
    "omits arbitrary response codes without leaking their values: %j",
    (code) => {
      const { host, error } = harness();
      new HttpExceptionTelemetryFilter().catch(
        new HttpException({ code, message: "private" }, 503),
        host as never,
      );
      expect(error.mock.calls[0]?.[0]).not.toHaveProperty("errorCode");
      expect(JSON.stringify(error.mock.calls)).not.toMatch(
        /13800138000|123456|PRIVATE_UPPERCASE_SECRET|private/,
      );
    },
  );
  it("retains typed Prisma code telemetry but rejects arbitrary top-level codes", () => {
    const valid = harness();
    new HttpExceptionTelemetryFilter().catch(
      Object.assign(new Error("private"), { code: "P2002" }),
      valid.host as never,
    );
    expect(valid.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "P2002" }),
      "request failed",
    );
    const invalid = harness();
    new HttpExceptionTelemetryFilter().catch(
      Object.assign(new Error("private"), { code: "PRIVATE_UPPERCASE_SECRET" }),
      invalid.host as never,
    );
    expect(invalid.error.mock.calls[0]?.[0]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(invalid.error.mock.calls)).not.toContain(
      "PRIVATE_UPPERCASE_SECRET",
    );
  });

  it("redacts the invitation from exception telemetry even when malformed", () => {
    const { host, error } = harness(
      "/v1/friend-payments/secret-invalid-token/reconcile?access_token=private",
    );
    new HttpExceptionTelemetryFilter().catch(
      new BadRequestException("无效邀请"),
      host as never,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/friend-payments/[redacted]/reconcile",
      }),
      "request failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toMatch(
      /secret-invalid-token|access_token|private/,
    );
  });
});

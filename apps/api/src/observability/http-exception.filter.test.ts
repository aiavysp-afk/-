import { BadRequestException } from "@nestjs/common";
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

  it("redacts the invitation from exception telemetry even when malformed", () => {
    const { host, error } = harness("/v1/friend-payments/secret-invalid-token/reconcile?access_token=private");
    new HttpExceptionTelemetryFilter().catch(new BadRequestException("无效邀请"), host as never);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/friend-payments/[redacted]/reconcile",
    }), "request failed");
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/secret-invalid-token|access_token|private/);
  });
});

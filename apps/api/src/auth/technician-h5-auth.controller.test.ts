import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TechnicianH5AuthController } from "./technician-h5-auth.controller.js";

describe("TechnicianH5AuthController", () => {
  it("returns configuration failures to the fixed H5 status page instead of exposing JSON", async () => {
    const h5Auth = {
      begin: vi.fn().mockRejectedValue(
        new ServiceUnavailableException({
          statusCode: 503,
          code: "CONFIGURATION_NOT_READY",
          message: "技师H5入驻通道尚未开放",
        }),
      ),
      configurationUnavailableRedirectUrl: vi
        .fn()
        .mockReturnValue("https://mtsc.top/technician/onboarding/#/configuration-unavailable"),
    };
    const controller = new TechnicianH5AuthController(h5Auth as never);
    const reply = { header: vi.fn(), code: vi.fn(), redirect: vi.fn() };
    reply.header.mockReturnValue(reply);
    reply.code.mockReturnValue(reply);

    await controller.start(reply as never);

    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(reply.code).toHaveBeenCalledWith(302);
    expect(reply.redirect).toHaveBeenCalledWith(
      "https://mtsc.top/technician/onboarding/#/configuration-unavailable",
    );
  });

  it("uses an explicit redirect status for a successful OAuth start", async () => {
    const controller = new TechnicianH5AuthController({
      begin: vi.fn().mockResolvedValue({
        authorizeUrl: "https://open.weixin.qq.com/connect/oauth2/authorize",
        browserBinding: "b".repeat(43),
        maxAgeSeconds: 600,
      }),
    } as never);
    const reply = { header: vi.fn(), code: vi.fn(), redirect: vi.fn() };
    reply.header.mockReturnValue(reply);
    reply.code.mockReturnValue(reply);

    await controller.start(reply as never);

    expect(reply.code).toHaveBeenCalledWith(302);
    expect(reply.redirect).toHaveBeenCalledWith(
      "https://open.weixin.qq.com/connect/oauth2/authorize",
    );
  });

  it("does not hide unrelated OAuth start failures", async () => {
    const failure = new ServiceUnavailableException("微信授权服务响应异常");
    const controller = new TechnicianH5AuthController({
      begin: vi.fn().mockRejectedValue(failure),
    } as never);

    await expect(controller.start({} as never)).rejects.toBe(failure);
  });

  it("marks the one-time ticket exchange response as non-cacheable", async () => {
    const exchange = vi.fn().mockResolvedValue({ sessionToken: "session" });
    const controller = new TechnicianH5AuthController({ exchange } as never);
    const reply = { header: vi.fn() };
    reply.header.mockReturnValue(reply);

    await expect(
      controller.exchange({ ticket: "t".repeat(32) }, reply as never),
    ).resolves.toEqual({ data: { sessionToken: "session" } });
    expect(reply.header).toHaveBeenNthCalledWith(
      1,
      "Cache-Control",
      "no-store",
    );
    expect(reply.header).toHaveBeenNthCalledWith(2, "Pragma", "no-cache");
  });

  it("sets non-cache headers even when the exchange payload is rejected", async () => {
    const controller = new TechnicianH5AuthController({
      exchange: vi.fn(),
    } as never);
    const reply = { header: vi.fn() };
    reply.header.mockReturnValue(reply);

    await expect(
      controller.exchange({}, reply as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(reply.header).toHaveBeenCalledWith("Pragma", "no-cache");
  });
});

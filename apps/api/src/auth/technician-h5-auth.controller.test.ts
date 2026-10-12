import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TechnicianH5AuthController } from "./technician-h5-auth.controller.js";

describe("TechnicianH5AuthController", () => {
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

import "reflect-metadata";
import { BadRequestException, RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants.js";
import { describe, expect, it, vi } from "vitest";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import {
  PublicTechnicianIntakeController,
  AdminTechnicianIntakeController,
} from "./technician-intake.controller.js";
describe("technician intake HTTP boundary", () => {
  it("exposes only an exact POST for anonymous submission, taking IP from Fastify rather than forwarded headers", async () => {
    const service = {
      submit: vi
        .fn()
        .mockResolvedValue({ receiptId: "receipt", status: "PENDING_REVIEW" }),
    };
    const controller = new PublicTechnicianIntakeController(service as never);
    expect(
      Reflect.getMetadata(PATH_METADATA, PublicTechnicianIntakeController),
    ).toBe("technician/intake");
    expect(Reflect.getMetadata(METHOD_METADATA, controller.submit)).toBe(
      RequestMethod.POST,
    );
    expect(
      Object.getOwnPropertyNames(PublicTechnicianIntakeController.prototype),
    ).toEqual(["constructor", "submit"]);
    const body = {
      name: "示例技师",
      phone: "13800138000",
      certificateBase64: "AAAA",
      consentAccepted: true,
    };
    await controller.submit(body, "submission-key", {
      ip: "trusted-ip",
      headers: { "x-forwarded-for": "spoof" },
    } as never);
    expect(service.submit).toHaveBeenCalledWith(
      body,
      "submission-key",
      "trusted-ip",
    );
    await expect(
      controller.submit({ ...body, organizationId: "foreign" }, "key", {
        ip: "trusted-ip",
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it("guards all private certificate/review routes and returns JPEG without caching or exposing fields", async () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminTechnicianIntakeController),
    ).toContain(SessionAuthGuard);
    const content = Buffer.from([255, 216, 255, 217]);
    const service = {
      certificate: vi.fn().mockResolvedValue(content),
      review: vi.fn().mockResolvedValue({}),
    };
    const controller = new AdminTechnicianIntakeController(service as never);
    const reply = { header: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.certificate(
      { userId: "operator" } as never,
      "org-a",
      "intake-a",
      reply as never,
    );
    expect(service.certificate).toHaveBeenCalledWith(
      { userId: "operator" },
      "org-a",
      "intake-a",
    );
    expect(reply.header).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store, max-age=0",
    );
    expect(reply.header).toHaveBeenCalledWith("Content-Type", "image/jpeg");
    expect(reply.send).toHaveBeenCalledWith(content);
    await expect(
      controller.approve({} as never, "org-a", "id", {
        expectedVersion: 1,
        role: "ADMIN",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.reject({} as never, "org-a", "id", {
        expectedVersion: 1,
        reason: "",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.review).not.toHaveBeenCalled();
  });
});

import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  SessionAuthGuard,
  requiresAdminStepUp,
} from "../auth/session-auth.guard.js";
import { AdminCustomerDirectoryController } from "./admin-customer-directory.controller.js";

function setup() {
  const directory = {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    revealPhone: vi.fn().mockResolvedValue({
      userId: "customer-1",
      phone: "13800138000",
      expiresAt: "2026-10-15T10:01:00.000Z",
    }),
  };
  return {
    directory,
    controller: new AdminCustomerDirectoryController(directory as never),
  };
}

describe("admin customer directory endpoints", () => {
  it("stays behind existing session authentication and uses sensitive POST reveal", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminCustomerDirectoryController),
    ).toContain(SessionAuthGuard);
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminCustomerDirectoryController),
    ).toBe("admin/organizations/:organizationId/customer-center/customers");
    const method = AdminCustomerDirectoryController.prototype.revealPhone;
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(
      ":customerId/reveal-phone",
    );
    expect(
      requiresAdminStepUp(
        "POST",
        "/v1/admin/organizations/org/customer-center/customers/user/reveal-phone",
      ),
    ).toBe(true);
  });

  it("marks list and complete-phone responses private and non-storable", () => {
    for (const method of [
      AdminCustomerDirectoryController.prototype.list,
      AdminCustomerDirectoryController.prototype.revealPhone,
    ]) {
      expect(Reflect.getMetadata(HEADERS_METADATA, method)).toEqual(
        expect.arrayContaining([
          { name: "Cache-Control", value: "private, no-store, max-age=0" },
          { name: "Pragma", value: "no-cache" },
        ]),
      );
    }
  });

  it("passes parsed page input without caller-supplied scope or full-phone switches", async () => {
    const f = setup();
    const actor = { userId: "operator" } as never;
    await expect(f.controller.list(actor, "org-1", {})).resolves.toEqual({
      data: { items: [], nextCursor: null },
    });
    expect(f.directory.list).toHaveBeenCalledWith(actor, "org-1", {
      limit: 20,
    });
    for (const query of [
      { limit: 101 },
      { organizationId: "other" },
      { includeFullPhone: true },
    ])
      await expect(
        f.controller.list(actor, "org-1", query),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.directory.list).toHaveBeenCalledOnce();
  });

  it("requires a purpose and does not accept injected permission or phone fields", async () => {
    const f = setup();
    const actor = { userId: "operator" } as never;
    await f.controller.revealPhone(actor, "org-1", "customer-1", {
      reason: "  核对预约联系 ",
    });
    expect(f.directory.revealPhone).toHaveBeenCalledWith(
      actor,
      "org-1",
      "customer-1",
      { reason: "核对预约联系" },
    );
    for (const body of [
      {},
      { reason: "查看" },
      { reason: "核对预约联系", mfaVerified: true },
      { reason: "核对预约联系", phone: "13800138000" },
    ])
      await expect(
        f.controller.revealPhone(actor, "org-1", "customer-1", body),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.directory.revealPhone).toHaveBeenCalledOnce();
  });

  it("fails closed rather than returning an accidental unmasked list field", async () => {
    const f = setup();
    f.directory.list.mockResolvedValue({
      items: [
        {
          userId: "customer-1",
          displayName: "客户",
          phoneVerified: true,
          maskedPhone: "13800138000",
          createdAt: "2026-10-15T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    } as never);
    await expect(f.controller.list({} as never, "org-1", {})).rejects.toThrow();
  });
});

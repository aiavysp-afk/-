import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it, vi } from "vitest";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SimpleAdminController } from "./simple-admin.controller.js";

const principal: AuthPrincipal = {
  userId: "operator",
  sessionId: "session",
  displayName: "运营",
  memberships: [{ organizationId: "org-a", role: "OPERATOR" }],
};
function fixture() {
  const service = {
    technicians: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    orders: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    users: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  return { service, controller: new SimpleAdminController(service as never) };
}
describe("simple admin HTTP boundary", () => {
  it("keeps the existing session guard on the organization-scoped route family", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SimpleAdminController)).toBe(
      "admin/organizations/:organizationId/simple",
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SimpleAdminController),
    ).toContain(SessionAuthGuard);
  });
  it("uses pending-review technicians by default and bounded cursors for all lists", async () => {
    const f = fixture();
    await expect(
      f.controller.technicians(principal, "org-a", {}),
    ).resolves.toEqual({ data: { items: [], nextCursor: null } });
    expect(f.service.technicians).toHaveBeenCalledWith(principal, "org-a", {
      limit: 20,
      status: "PENDING_REVIEW",
    });
    await f.controller.orders(principal, "org-a", {
      limit: "10",
      cursor: "order-1",
    });
    expect(f.service.orders).toHaveBeenCalledWith(principal, "org-a", {
      limit: 10,
      status: "ALL",
      cursor: "order-1",
    });
    await f.controller.users(principal, "org-a", {});
    expect(f.service.users).toHaveBeenCalledWith(principal, "org-a", {
      limit: 20,
    });
  });
  it("rejects invalid statuses, unbounded limits, foreign tenant query injection, and unsupported cursor characters", async () => {
    const f = fixture();
    await expect(
      f.controller.orders(principal, "org-a", { limit: 101 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.controller.orders(principal, "org-a", { status: "INVALID" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.controller.technicians(principal, "org-a", { organizationId: "org-b" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.controller.users(principal, "org-a", { cursor: "../users" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.service.orders).not.toHaveBeenCalled();
    expect(f.service.technicians).not.toHaveBeenCalled();
    expect(f.service.users).not.toHaveBeenCalled();
  });
});

import { BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminCatalogController } from "./admin-catalog.controller.js";
import type { CatalogService } from "./catalog.service.js";

const principal: AuthPrincipal = {
  sessionId: "synthetic-session",
  userId: "synthetic-operator",
  displayName: "测试运营",
  memberships: [{ organizationId: "synthetic-org", role: UserRole.OPERATOR }],
};
const draft = {
  clientRequestId: "8c297804-3c27-43c4-98e2-c3505f3c4e21",
  organizationId: "synthetic-org",
  name: "中式推拿",
  category: "MASSAGE",
  subtitle: "日常放松养护",
  description: "规范透明的非医疗上门保健放松服务。",
  durationMinutes: 60,
  priceFen: 21_800,
  steps: ["沟通确认", "规范服务"],
  boundaries: ["不提供医疗服务"],
};

describe("admin catalog validation", () => {
  it("validates a complete scoped draft before invoking the mutation service", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "service-fixture", published: false });
    const controller = new AdminCatalogController({
      create,
    } as unknown as CatalogService);
    await expect(
      controller.create(principal, { ...draft, published: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
    await controller.create(principal, draft);
    expect(create).toHaveBeenCalledWith(principal, {
      ...draft,
      featured: false,
    });
  });

  it("requires a deletion snapshot before invoking its service", async () => {
    const remove = vi
      .fn()
      .mockResolvedValue({ id: "service-fixture", deleted: true });
    const controller = new AdminCatalogController({
      remove,
    } as unknown as CatalogService);
    await expect(
      controller.remove(principal, "service-fixture", {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(remove).not.toHaveBeenCalled();
    const snapshot = { expectedUpdatedAt: "2026-10-30T00:00:00.000Z" };
    await expect(
      controller.remove(principal, "service-fixture", snapshot),
    ).resolves.toEqual({ data: { id: "service-fixture", deleted: true } });
    expect(remove).toHaveBeenCalledWith(principal, "service-fixture", snapshot);
  });
});

import { ForbiddenException } from "@nestjs/common";
import { ServiceCategory, UserRole, type Service } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { PrismaService } from "../database/prisma.service.js";
import { CatalogService } from "./catalog.service.js";

const record = (overrides: Partial<Service> = {}): Service => ({
  id: "svc-1",
  organizationId: "org-a",
  slug: "neck-relax-60",
  name: "肩颈舒缓",
  category: ServiceCategory.MASSAGE,
  subtitle: "日常非医疗放松",
  badge: "人气之选",
  description: "规范、透明的肩颈背部非医疗放松服务。",
  durationMinutes: 60,
  priceFen: 19_800n,
  featured: true,
  published: true,
  steps: ["服务前沟通", "规范服务", "结束反馈"],
  boundaries: ["不提供医疗诊断", "不涉及私密部位"],
  createdAt: new Date("2026-10-03T00:00:00.000Z"),
  updatedAt: new Date("2026-10-03T00:00:00.000Z"),
  ...overrides,
});

const operator: AuthPrincipal = {
  sessionId: "session-operator",
  userId: "operator-1",
  displayName: "运营人员",
  memberships: [{ organizationId: "org-a", role: UserRole.OPERATOR }],
};

describe("CatalogService", () => {
  it("returns only published database services and serializes bigint money as integer fen", async () => {
    const findMany = vi.fn().mockResolvedValue([record()]);
    const catalog = new CatalogService(
      { service: { findMany } } as unknown as PrismaService,
      new AccessControlService(),
    );

    const result = await catalog.listPublished();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(result[0]?.priceFen).toBe(19_800);
    expect(typeof result[0]?.priceFen).toBe("number");
  });

  it("returns only published reviews belonging to the requested service", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "review-1",
        technicianId: "tech-1",
        rating: 5,
        content: "流程规范，沟通清楚",
        createdAt: new Date("2026-10-08T02:00:00.000Z"),
        customer: { displayName: "王女士" },
      },
    ]);
    const catalog = new CatalogService(
      {
        service: {
          findFirst: vi.fn().mockResolvedValue({ id: "svc-1" }),
        },
        technicianReview: { findMany },
      } as unknown as PrismaService,
      new AccessControlService(),
    );

    const result = await catalog.listPublishedReviews("neck-relax-60");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PUBLISHED",
          order: { items: { some: { serviceId: "svc-1" } } },
        },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({ customerAlias: "王**", rating: 5 }),
    ]);
  });

  it("rejects edits to a service owned by another organization before writing", async () => {
    const update = vi.fn();
    const catalog = new CatalogService(
      {
        service: {
          findUnique: vi
            .fn()
            .mockResolvedValue(record({ organizationId: "org-b" })),
        },
        $transaction: update,
      } as unknown as PrismaService,
      new AccessControlService(),
    );

    await expect(
      catalog.update(operator, "svc-1", { priceFen: 20_800 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("writes integer-fen edits and an audit event in one transaction", async () => {
    const tx = {
      service: {
        update: vi.fn().mockResolvedValue(record({ priceFen: 20_800n })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      service: { findUnique: vi.fn().mockResolvedValue(record()) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const catalog = new CatalogService(prisma, new AccessControlService());

    const result = await catalog.update(operator, "svc-1", {
      priceFen: 20_800,
    });

    expect(tx.service.update).toHaveBeenCalledWith({
      where: { id: "svc-1" },
      data: { priceFen: 20_800n },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.priceFen).toBe(20_800);
  });

  it("refuses to publish incomplete service boundaries", async () => {
    const catalog = new CatalogService(
      {
        service: {
          findUnique: vi
            .fn()
            .mockResolvedValue(record({ published: false, boundaries: [] })),
        },
      } as unknown as PrismaService,
      new AccessControlService(),
    );

    await expect(
      catalog.setPublished(operator, "svc-1", true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

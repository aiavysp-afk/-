import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  Prisma,
  ServiceCategory,
  UserRole,
  type Service,
} from "@prisma/client";
import type { ServiceAdminCreate } from "@zydj/contracts";
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
      $queryRaw: vi.fn().mockResolvedValue([{ id: "svc-1" }]),
      service: {
        findUnique: vi.fn().mockResolvedValue(record()),
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
      data: { priceFen: 20_800n, updatedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.priceFen).toBe(20_800);
  });

  it("refuses to publish incomplete service boundaries", async () => {
    const incomplete = record({ published: false, boundaries: [] });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "svc-1" }]),
      service: { findUnique: vi.fn().mockResolvedValue(incomplete) },
    };
    const catalog = new CatalogService(
      {
        service: {
          findUnique: vi.fn().mockResolvedValue(incomplete),
        },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      new AccessControlService(),
    );

    await expect(
      catalog.setPublished(operator, "svc-1", true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

const createInput: ServiceAdminCreate = {
  clientRequestId: "8c297804-3c27-43c4-98e2-c3505f3c4e21",
  organizationId: "org-a",
  name: "肩颈舒缓",
  category: "MASSAGE",
  subtitle: "日常非医疗放松",
  badge: "人气之选",
  description: "规范、透明的肩颈背部非医疗放松服务。",
  durationMinutes: 60,
  priceFen: 19_800,
  featured: true,
  steps: ["服务前沟通", "规范服务", "结束反馈"],
  boundaries: ["不提供医疗诊断", "不涉及私密部位"],
};

function mutationFixture(initial = record({ published: false })) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: initial.id }]),
    service: {
      findUnique: vi.fn().mockResolvedValue(initial),
      create: vi.fn().mockResolvedValue(initial),
      update: vi.fn().mockResolvedValue(initial),
      delete: vi.fn().mockResolvedValue(initial),
    },
    orderItem: { count: vi.fn().mockResolvedValue(0) },
    appointmentReservation: { count: vi.fn().mockResolvedValue(0) },
    technicianProfile: { count: vi.fn().mockResolvedValue(0) },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "audit-fixture" }),
    },
  };
  const prisma = {
    service: { findUnique: vi.fn().mockResolvedValue(initial) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    tx,
    prisma,
    catalog: new CatalogService(
      prisma as unknown as PrismaService,
      new AccessControlService(),
    ),
  };
}

describe("service management lifecycle", () => {
  it("creates a database draft and audit together using a retry-safe slug, never publishes it", async () => {
    const f = mutationFixture();
    f.tx.service.findUnique.mockResolvedValueOnce(null as never);
    const result = await f.catalog.create(operator, createInput);
    expect(f.tx.service.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-a",
        slug: `service-${createInput.clientRequestId}`,
        priceFen: 19_800n,
        published: false,
      }),
    });
    expect(result.published).toBe(false);
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CATALOG_SERVICE_CREATED",
        actorId: operator.userId,
        organizationId: "org-a",
        resourceId: "svc-1",
      }),
    });
  });

  it("rejects creating in another organization before a database mutation", async () => {
    const f = mutationFixture();
    await expect(
      f.catalog.create(operator, { ...createInput, organizationId: "org-b" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("replays an identical explicit creation retry without a second write or audit", async () => {
    const f = mutationFixture(
      record({
        slug: `service-${createInput.clientRequestId}`,
        published: false,
      }),
    );
    expect((await f.catalog.create(operator, createInput)).id).toBe("svc-1");
    expect(f.tx.service.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not resurrect a deleted service when an old creation request is retried", async () => {
    const f = mutationFixture();
    f.tx.service.findUnique.mockResolvedValueOnce(null as never);
    f.tx.auditLog.findFirst.mockResolvedValueOnce({
      id: "previous-create",
    } as never);
    await expect(f.catalog.create(operator, createInput)).rejects.toThrow(
      "项目已删除",
    );
    expect(f.tx.service.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    { organizationId: "org-b" },
    { name: "另一服务" },
    { priceFen: 29900n },
  ])(
    "does not reuse a creation UUID for different content or tenant",
    async (overrides) => {
      const f = mutationFixture(record({ ...overrides, published: false }));
      await expect(
        f.catalog.create(operator, createInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.tx.service.create).not.toHaveBeenCalled();
    },
  );

  it("recovers the other transaction's result after a concurrent identical creation", async () => {
    const f = mutationFixture();
    f.prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("fixture unique conflict", {
        code: "P2002",
        clientVersion: "fixture",
      }),
    );
    expect((await f.catalog.create(operator, createInput)).id).toBe("svc-1");
    expect(f.prisma.service.findUnique).toHaveBeenCalledWith({
      where: { slug: `service-${createInput.clientRequestId}` },
    });
  });

  it("locks and rereads the service before checking the UI edit snapshot", async () => {
    const f = mutationFixture();
    f.tx.service.findUnique.mockResolvedValueOnce(
      record({ updatedAt: new Date("2026-10-04T00:00:00.000Z") }),
    );
    await expect(
      f.catalog.update(operator, "svc-1", {
        name: "新的项目",
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("项目资料已变更");
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.tx.service.update).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("monotonically advances the service timestamp even when the clock is behind the stored value", async () => {
    const initial = record({ updatedAt: new Date("2099-01-01T00:00:00.000Z") });
    const f = mutationFixture(initial);
    await f.catalog.update(operator, "svc-1", {
      name: "新的项目",
      expectedUpdatedAt: initial.updatedAt.toISOString(),
    });
    const data = f.tx.service.update.mock.calls[0]![0].data;
    expect(data.updatedAt.getTime()).toBe(initial.updatedAt.getTime() + 1);
    expect(data).not.toHaveProperty("expectedUpdatedAt");
  });

  it("does not delete a currently published service", async () => {
    const f = mutationFixture(record());
    await expect(
      f.catalog.remove(operator, "svc-1", {
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("先下架");
    expect(f.tx.service.delete).not.toHaveBeenCalled();
  });

  it("does not delete a service edited after the list was loaded", async () => {
    const f = mutationFixture(
      record({
        published: false,
        updatedAt: new Date("2026-10-04T00:00:00.000Z"),
      }),
    );
    await expect(
      f.catalog.remove(operator, "svc-1", {
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("项目资料已变更");
    expect(f.tx.service.delete).not.toHaveBeenCalled();
  });

  it.each([
    "orderItem",
    "appointmentReservation",
    "technicianProfile",
  ] as const)(
    "retains history when a service is referenced by %s",
    async (resource) => {
      const f = mutationFixture();
      f.tx[resource].count.mockResolvedValueOnce(1);
      await expect(
        f.catalog.remove(operator, "svc-1", {
          expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.tx.service.delete).not.toHaveBeenCalled();
      expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("deletes only an unreferenced unpublished service and records an audit", async () => {
    const f = mutationFixture();
    await expect(
      f.catalog.remove(operator, "svc-1", {
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({ id: "svc-1", deleted: true });
    expect(f.tx.service.delete).toHaveBeenCalledWith({
      where: { id: "svc-1" },
    });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CATALOG_SERVICE_DELETED",
        organizationId: "org-a",
        actorId: operator.userId,
      }),
    });
  });

  it("reports a concurrent booking FK conflict without deleting history", async () => {
    const f = mutationFixture();
    f.tx.service.delete.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("fixture booking conflict", {
        code: "P2003",
        clientVersion: "fixture",
      }),
    );
    await expect(
      f.catalog.remove(operator, "svc-1", {
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("已有预约或订单");
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects deletion of another organization's service before acquiring a lock", async () => {
    const f = mutationFixture(
      record({ organizationId: "org-b", published: false }),
    );
    await expect(
      f.catalog.remove(operator, "svc-1", {
        expectedUpdatedAt: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});

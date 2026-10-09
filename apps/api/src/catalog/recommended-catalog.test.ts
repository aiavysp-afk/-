import type { Prisma, Service } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  applyRecommendedCatalog,
  assertRecommendedCatalogTarget,
  planRecommendedCatalog,
  recommendedCatalog,
  RECOMMENDED_CATALOG_ORGANIZATION_ID,
} from "./recommended-catalog.js";

const service = (overrides: Partial<Service> = {}): Service => ({
  id: "original-french-service-id",
  organizationId: RECOMMENDED_CATALOG_ORGANIZATION_ID,
  slug: "existing-french-slug",
  name: "法式SPA",
  category: "SPA_RELAXATION",
  subtitle: "原有说明",
  badge: null,
  description: "原有服务说明",
  durationMinutes: 90,
  priceFen: 26_800n,
  featured: false,
  published: true,
  steps: ["原有步骤"],
  boundaries: ["非医疗"],
  createdAt: new Date("2026-10-03T00:00:00Z"),
  updatedAt: new Date("2026-10-03T00:00:00Z"),
  ...overrides,
});

describe("recommended catalog scoped patch", () => {
  it("creates exactly the requested prices and durations while retaining original service identities", () => {
    const previous = service();
    const plan = planRecommendedCatalog([previous]);
    expect(plan[0]).toMatchObject({
      action: "UPDATE",
      id: previous.id,
      slug: previous.slug,
      content: { priceFen: 49_800n, durationMinutes: 120 },
    });
    expect(
      plan.map((item) => [
        item.content.name,
        Number(item.content.priceFen),
        item.content.durationMinutes,
      ]),
    ).toEqual([
      ["法式SPA", 49_800, 120],
      ["泰式SPA", 39_800, 120],
      ["通络培元", 29_800, 80],
      ["中式推拿", 21_800, 60],
      ["非遗采耳", 23_800, 70],
    ]);
    expect(plan.map((item) => item.id)).not.toContain("svc-neck-60");
  });

  it("refuses cross-organization collisions and ambiguous existing products", () => {
    expect(() =>
      planRecommendedCatalog([
        service({
          slug: recommendedCatalog[0]!.slug,
          organizationId: "other-org",
        }),
      ]),
    ).toThrow("another organization");
    expect(() =>
      planRecommendedCatalog([
        service(),
        service({ id: "duplicate-french-id", slug: "duplicate-french-slug" }),
      ]),
    ).toThrow("Ambiguous");
    expect(() =>
      planRecommendedCatalog([
        service({ id: recommendedCatalog[0]!.id, name: "足部舒缓" }),
      ]),
    ).toThrow("unrelated");
  });

  it("repeated application writes no audit or events once the requested data already matches", async () => {
    const existing = planRecommendedCatalog([]).map((item) =>
      service({ id: item.id, slug: item.slug, ...item.content }),
    );
    const plan = planRecommendedCatalog(existing);
    expect(plan.every((item) => item.action === "UNCHANGED")).toBe(true);
    const tx = {
      service: { create: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    await applyRecommendedCatalog(
      tx as unknown as Prisma.TransactionClient,
      plan,
    );
    expect(tx.service.create).not.toHaveBeenCalled();
    expect(tx.service.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("updates only catalog content and writes matching audit and outbox events", async () => {
    const tx = {
      service: { create: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const plan = planRecommendedCatalog([service()]);
    await applyRecommendedCatalog(
      tx as unknown as Prisma.TransactionClient,
      plan,
    );
    expect(tx.service.update).toHaveBeenCalledWith({
      where: { id: "original-french-service-id" },
      data: plan[0]!.content,
    });
    expect(tx.service.create).toHaveBeenCalledTimes(4);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(5);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(5);
    expect(Object.keys(plan[0]!.content)).not.toEqual(
      expect.arrayContaining(["id", "slug", "organizationId"]),
    );
  });

  it("restricts the script to the existing local production database without printing credentials", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:secret@127.0.0.1:5432/zhongyuan_daojia",
    };
    expect(() => assertRecommendedCatalogTarget(env)).not.toThrow();
    for (const databaseUrl of [
      "postgresql://user:secret@remote-host/zhongyuan_daojia",
      "postgresql://user:secret@localhost/another_database",
      "invalid",
    ]) {
      expect(() =>
        assertRecommendedCatalogTarget({ ...env, DATABASE_URL: databaseUrl }),
      ).toThrow();
    }
    expect(() =>
      assertRecommendedCatalogTarget({ ...env, NODE_ENV: "development" }),
    ).toThrow();
  });
});

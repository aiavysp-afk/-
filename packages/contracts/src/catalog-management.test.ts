import { describe, expect, it } from "vitest";
import {
  ServiceAdminCreateSchema,
  ServiceAdminDeleteSchema,
  ServiceAdminUpdateSchema,
} from "./index.js";

const draft = {
  clientRequestId: "8c297804-3c27-43c4-98e2-c3505f3c4e21",
  organizationId: "org-test",
  name: "中式推拿",
  category: "MASSAGE",
  subtitle: "日常放松养护",
  description: "规范透明的非医疗上门保健放松服务。",
  durationMinutes: 60,
  priceFen: 21_800,
  steps: ["沟通确认", "规范服务"],
  boundaries: ["不提供医疗服务"],
};

describe("catalog management mutation contracts", () => {
  it("requires a scoped complete draft and a stable creation retry UUID", () => {
    expect(ServiceAdminCreateSchema.parse(draft)).toMatchObject({
      featured: false,
      priceFen: 21_800,
    });
    expect(
      ServiceAdminCreateSchema.parse({
        ...draft,
        clientRequestId: draft.clientRequestId.toUpperCase(),
      }).clientRequestId,
    ).toBe(draft.clientRequestId);
    const { clientRequestId: _retry, ...withoutRetry } = draft;
    const { organizationId: _organization, ...withoutScope } = draft;
    expect(ServiceAdminCreateSchema.safeParse(withoutRetry).success).toBe(
      false,
    );
    expect(ServiceAdminCreateSchema.safeParse(withoutScope).success).toBe(
      false,
    );
  });

  it.each([
    { published: true },
    { slug: "caller-slug" },
    { priceFen: 218.5 },
    { priceFen: -1 },
    { priceFen: 100_000_001 },
    { durationMinutes: 0 },
    { durationMinutes: 481 },
    { steps: [] },
    { boundaries: [" "] },
    { category: "MEDICAL" },
    { clientRequestId: "not-a-uuid" },
  ])("rejects invalid or client-controlled fields: %j", (patch) => {
    expect(
      ServiceAdminCreateSchema.safeParse({ ...draft, ...patch }).success,
    ).toBe(false);
  });

  it("permits a snapshot edit but rejects a snapshot with no actual update", () => {
    expect(
      ServiceAdminUpdateSchema.safeParse({
        expectedUpdatedAt: "2026-10-30T00:00:00.000Z",
        name: "新的项目",
      }).success,
    ).toBe(true);
    expect(
      ServiceAdminUpdateSchema.safeParse({
        expectedUpdatedAt: "2026-10-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ServiceAdminUpdateSchema.safeParse({
        organizationId: "other-org",
        name: "新的项目",
      }).success,
    ).toBe(false);
  });

  it("requires an exact snapshot for deletion and accepts no extra destructive flags", () => {
    expect(
      ServiceAdminDeleteSchema.safeParse({
        expectedUpdatedAt: "2026-10-30T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(ServiceAdminDeleteSchema.safeParse({}).success).toBe(false);
    expect(
      ServiceAdminDeleteSchema.safeParse({
        expectedUpdatedAt: "2026-10-30T00:00:00.000Z",
        force: true,
      }).success,
    ).toBe(false);
  });
});

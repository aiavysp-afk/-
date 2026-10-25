import { describe, expect, it, vi } from "vitest";
import { HomeCampaignSaveSchema } from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import {
  campaignActive,
  campaignView,
  DEFAULT_CAMPAIGN,
  HomeCampaignService,
} from "./home-campaign.service.js";

const operator: AuthPrincipal = {
  userId: "operator",
  sessionId: "s",
  displayName: "Operator",
  memberships: [{ organizationId: "org", role: "OPERATOR" }],
};
const row = () => ({
  organizationId: "org",
  version: 2,
  content: { ...DEFAULT_CAMPAIGN, enabled: true },
  imageBytes: new Uint8Array([1, 2]),
});
function fixture() {
  const db = {
    homeCampaign: {
      findUnique: vi.fn().mockResolvedValue(row()),
      upsert: vi.fn(),
    },
    service: {
      findFirst: vi.fn().mockResolvedValue({ organizationId: "org" }),
    },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "org" }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const photos = {
    normalize: vi.fn().mockResolvedValue({ content: new Uint8Array([3]) }),
  };
  return {
    db,
    photos,
    service: new HomeCampaignService(
      db as never,
      new AccessControlService(),
      photos as never,
    ),
  };
}
describe("home campaigns", () => {
  it("respects start and exclusive expiry boundaries", () => {
    const c = {
      ...DEFAULT_CAMPAIGN,
      enabled: true,
      startsAt: "2026-10-25T00:00:00Z",
      endsAt: "2026-10-26T00:00:00Z",
    };
    expect(campaignActive(c, Date.parse(c.startsAt) - 1)).toBe(false);
    expect(campaignActive(c, Date.parse(c.startsAt))).toBe(true);
    expect(campaignActive(c, Date.parse(c.endsAt))).toBe(false);
    expect(
      campaignActive({ ...c, enabled: false }, Date.parse(c.startsAt)),
    ).toBe(false);
  });
  it("rejects arbitrary destinations, reversed windows and oversized upload", () => {
    const input = { ...DEFAULT_CAMPAIGN, expectedVersion: 0 };
    expect(
      HomeCampaignSaveSchema.safeParse({
        ...input,
        target: "https://evil.invalid",
      }).success,
    ).toBe(false);
    expect(
      HomeCampaignSaveSchema.safeParse({
        ...input,
        startsAt: "2026-10-26T00:00:00Z",
        endsAt: "2026-10-25T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      HomeCampaignSaveSchema.safeParse({
        ...input,
        imageBase64: "A".repeat(700000),
      }).success,
    ).toBe(false);
  });
  it("rejects customer and cross-organization editing before touching data", async () => {
    const { db, service } = fixture();
    await expect(
      service.admin({ ...operator, memberships: [] }, "org"),
    ).rejects.toThrow();
    await expect(
      service.save(operator, "other", {
        ...DEFAULT_CAMPAIGN,
        expectedVersion: 2,
      }),
    ).rejects.toThrow();
    expect(db.homeCampaign.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("rejects stale saves without overwriting data", async () => {
    const { db, service } = fixture();
    await expect(
      service.save(operator, "org", {
        ...DEFAULT_CAMPAIGN,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("活动已被其他人修改");
    expect(db.homeCampaign.upsert).not.toHaveBeenCalled();
  });
  it("normalizes image input, increments version and audits without image bytes", async () => {
    const { db, photos, service } = fixture();
    await service.save(operator, "org", {
      ...DEFAULT_CAMPAIGN,
      expectedVersion: 2,
      imageBase64: "AQ==",
    });
    expect(photos.normalize).toHaveBeenCalledWith("AQ==");
    expect(db.homeCampaign.upsert.mock.calls[0]![0].update).toMatchObject({
      version: { increment: 1 },
      imageBytes: new Uint8Array([3]),
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain("AQ==");
  });
  it("keeps omitted pictures and clears explicitly removed pictures", async () => {
    const { db, service } = fixture();
    await service.save(operator, "org", {
      ...DEFAULT_CAMPAIGN,
      expectedVersion: 2,
    });
    expect(db.homeCampaign.upsert.mock.calls[0]![0].update).not.toHaveProperty(
      "imageBytes",
    );
    await service.save(operator, "org", {
      ...DEFAULT_CAMPAIGN,
      expectedVersion: 2,
      imageBase64: null,
    });
    expect(
      db.homeCampaign.upsert.mock.calls[1]![0].update.imageBytes,
    ).toBeNull();
  });
  it("excludes image bytes and disabled campaigns from public metadata", async () => {
    const { db, service } = fixture();
    expect(campaignView(row())).not.toHaveProperty("imageBytes");
    db.homeCampaign.findUnique.mockResolvedValue({
      ...row(),
      content: DEFAULT_CAMPAIGN,
    });
    expect(await service.current()).toBeNull();
    await expect(service.image("org", 2)).rejects.toThrow();
  });
  it("rejects cross-tenant and obsolete image versions", async () => {
    const { service } = fixture();
    await expect(service.image("other", 2)).rejects.toThrow();
    await expect(service.image("org", 1)).rejects.toThrow();
  });
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { TechnicianPhotoService } from "../src/technicians/technician-photo.service.js";
import {
  HomeCampaignService,
  DEFAULT_CAMPAIGN,
} from "../src/customer-center/home-campaign.service.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";

const raw = process.env.HOME_CAMPAIGN_TEST_DATABASE_URL;
if (!raw) throw new Error("Explicit isolated campaign test database required");
const url = new URL(raw);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.username !== "zydj_acceptance" ||
  !/^\/zydj_technician_phone_acceptance_20261022_[a-f0-9]{8,32}$/.test(
    url.pathname,
  )
) {
  throw new Error("Refusing a non-dedicated campaign test database");
}
const prisma = new PrismaClient({ datasourceUrl: raw });
const prefix = `campaign-acceptance-${randomUUID()}`;
try {
  const org = await prisma.organization.create({ data: { name: prefix } });
  const principal: AuthPrincipal = {
    userId: `${prefix}-operator`,
    sessionId: prefix,
    displayName: "Isolated operator",
    memberships: [{ organizationId: org.id, role: "OPERATOR" }],
  };
  const service = new HomeCampaignService(
    prisma as never,
    new AccessControlService(),
    new TechnicianPhotoService(new ConfigService() as never),
  );
  const saves = await Promise.allSettled([
    service.save(principal, org.id, {
      ...DEFAULT_CAMPAIGN,
      enabled: true,
      expectedVersion: 0,
    }),
    service.save(principal, org.id, {
      ...DEFAULT_CAMPAIGN,
      enabled: true,
      expectedVersion: 0,
    }),
  ]);
  assert.equal(saves.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(saves.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await service.admin(principal, org.id)).version, 1);
  assert.equal(
    await prisma.auditLog.count({ where: { organizationId: org.id } }),
    1,
  );
  await prisma.service.create({
    data: {
      organizationId: org.id,
      slug: prefix,
      name: "Isolated service",
      category: "MASSAGE",
      subtitle: "fixture",
      description: "fixture",
      durationMinutes: 60,
      priceFen: 19800,
      published: true,
      steps: [],
      boundaries: [],
    },
  });
  const image = await sharp({
    create: { width: 200, height: 200, channels: 3, background: "#16583f" },
  })
    .png()
    .toBuffer();
  const saved = await service.save(principal, org.id, {
    ...DEFAULT_CAMPAIGN,
    enabled: true,
    expectedVersion: 1,
    imageBase64: image.toString("base64"),
  });
  assert.equal(saved.version, 2);
  assert.ok(saved.imageDataUrl?.startsWith("data:image/jpeg;base64,"));
  const current = await service.current();
  assert.equal(current?.organizationId, org.id);
  assert.ok(current?.imagePath?.endsWith("/2"));
  assert.equal("imageDataUrl" in current!, false);
  assert.equal("imageBytes" in current!, false);
  const decoded = await sharp(await service.image(org.id, 2)).metadata();
  assert.equal(decoded.format, "jpeg");
  await assert.rejects(() => service.image("foreign-org", 2));
  await assert.rejects(() => service.image(org.id, 1));
  await assert.rejects(() =>
    service.save({ ...principal, memberships: [] }, org.id, {
      ...DEFAULT_CAMPAIGN,
      expectedVersion: 2,
    }),
  );
  await service.save(principal, org.id, {
    ...DEFAULT_CAMPAIGN,
    enabled: false,
    expectedVersion: 2,
  });
  assert.equal(await service.current(), null);
  await assert.rejects(() => service.image(org.id, 3));
  console.log(
    JSON.stringify({
      passed: true,
      concurrentFirstSave: true,
      privateImagePreview: true,
      decodedPublicImage: true,
      tenantAndVersionChecks: true,
      disabledCampaignHidden: true,
      realSmsSent: false,
    }),
  );
} finally {
  await prisma.$disconnect();
}

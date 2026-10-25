import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { TechnicianPhotoService } from "../src/technicians/technician-photo.service.js";
import { TechnicianPhotoDraftsService } from "../src/technicians/technician-photo-drafts.service.js";

const raw = process.env.PHOTO_BINDING_TEST_DATABASE_URL;
if (!raw) throw new Error("Explicit isolated binding database required");
const url = new URL(raw);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.username !== "zydj_acceptance" ||
  !/^\/zydj_technician_phone_acceptance_20261022_[a-f0-9]{8,32}$/.test(
    url.pathname,
  )
)
  throw new Error("Refusing non-dedicated DB");
const prisma = new PrismaClient({ datasourceUrl: raw });
const config = new ConfigService({
  NODE_ENV: "test",
  STAFF_MFA_REQUIRED: "true",
  WECHAT_MINIAPP_APP_ID: "wx-binding-fixture",
  TECHNICIAN_PHOTO_PUBLIC_BASE_URL: "https://fixture.invalid/v1",
  DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
  AUTH_SESSION_PEPPER: randomBytes(32).toString("hex"),
});
const crypto = new AuthCryptoService(config as never);
const photos = new TechnicianPhotoService(config as never);
const service = new TechnicianPhotoDraftsService(
  prisma as never,
  new AccessControlService(config),
  crypto,
  photos,
  config as never,
);
let sequence = 0;
try {
  const org = await prisma.organization.create({
    data: { name: `binding-${randomUUID()}` },
  });
  const foreign = await prisma.organization.create({
    data: { name: `foreign-${randomUUID()}` },
  });
  const principal = {
    userId: "fixture-operator",
    sessionId: "fixture-session",
    displayName: "Fixture operator",
    mfaVerifiedUntil: new Date(Date.now() + 300000),
    memberships: [{ organizationId: org.id, role: "OPERATOR" as const }],
  };
  const sourceImage = await photos.normalize(
    (
      await sharp({
        create: { width: 32, height: 48, channels: 3, background: "#16583f" },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  );
  async function source() {
    const photoId = randomUUID();
    const user = await prisma.user.create({
      data: {
        role: "CUSTOMER",
        displayName: `photo-draft-${sequence++}`,
        organizationId: org.id,
      },
    });
    return prisma.technicianProfile.create({
      data: {
        organizationId: org.id,
        technicianId: user.id,
        registrationChannel: "ADMIN_PHOTO_DRAFT",
        avatarUrl: photos.publicUrl(user.id, photoId),
        photos: { create: { id: photoId, ...sourceImage } },
      },
    });
  }
  async function target(
    organizationId = org.id,
    options: {
      role?: "CUSTOMER" | "OPERATOR";
      channel?: string;
      wrongApp?: boolean;
    } = {},
  ) {
    const phone = `199${randomInt(10000000, 99999999)}`;
    const user = await prisma.user.create({
      data: {
        organizationId,
        role: options.role ?? "CUSTOMER",
        displayName: "fixture applicant",
        phoneEncrypted: crypto.encrypt(phone),
        phoneVerifiedAt: new Date(),
        customerPhoneIdentity: {
          create: { phoneHash: crypto.hashPhoneVerification("phone", phone) },
        },
      },
    });
    const profile = await prisma.technicianProfile.create({
      data: {
        organizationId,
        technicianId: user.id,
        registrationChannel: options.channel ?? "TECHNICIAN_PHONE",
        selfRegistered: true,
        introduction: "本人已填介绍须保留",
        serviceCity: "郑州市",
        realNameEncrypted: crypto.encryptScoped(
          `technician-real-name:temporary`,
          "占位",
        ),
      },
    });
    await prisma.technicianProfile.update({
      where: { id: profile.id },
      data: {
        realNameEncrypted: crypto.encryptScoped(
          `technician-real-name:${profile.id}`,
          "隔离测试姓名",
        ),
      },
    });
    if (options.channel === "WECHAT_MINIAPP")
      await prisma.externalIdentity.create({
        data: {
          userId: user.id,
          provider: "WECHAT_MINIAPP",
          subjectHash: crypto.hashIdentity(
            options.wrongApp ? "wx-wrong-app" : "wx-binding-fixture",
            user.id,
          ),
          subjectEncrypted: crypto.encrypt(user.id),
        },
      });
    return {
      profile: await prisma.technicianProfile.findUniqueOrThrow({
        where: { id: profile.id },
      }),
      phone,
    };
  }
  const s = await source(),
    t = await target();
  const wrongOrg = await target(foreign.id),
    manager = await target(org.id, { role: "OPERATOR" }),
    wrongApp = await target(org.id, {
      channel: "WECHAT_MINIAPP",
      wrongApp: true,
    }),
    wechat = await target(org.id, { channel: "WECHAT_MINIAPP" });
  const candidates = await service.targets(principal, org.id, s.technicianId);
  assert.ok(
    candidates.targets.some((x) => x.technicianId === t.profile.technicianId),
  );
  assert.ok(
    candidates.targets.some(
      (x) => x.technicianId === wechat.profile.technicianId,
    ),
  );
  assert.ok(
    !candidates.targets.some((x) =>
      [
        manager.profile.technicianId,
        wrongApp.profile.technicianId,
        wrongOrg.profile.technicianId,
      ].includes(x.technicianId),
    ),
  );
  assert.ok(!JSON.stringify(candidates).includes(t.phone));
  await assert.rejects(() =>
    service.targets({ ...principal, memberships: [] }, org.id, s.technicianId),
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: wrongOrg.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 0,
    }),
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: manager.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 0,
    }),
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: wrongApp.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 0,
    }),
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: t.profile.technicianId,
      expectedSourceVersion: 99,
      expectedTargetVersion: 0,
    }),
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: t.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 99,
    }),
  );
  const request = {
    targetTechnicianId: t.profile.technicianId,
    expectedSourceVersion: 0,
    expectedTargetVersion: 0,
  };
  const results = await Promise.all([
    service.bind(principal, org.id, s.technicianId, request),
    service.bind(principal, org.id, s.technicianId, request),
  ]);
  assert.equal(results.filter((r) => r.idempotentReplay).length, 1);
  const bound = await prisma.technicianProfile.findUniqueOrThrow({
    where: { id: t.profile.id },
    include: {
      photos: true,
      technician: { include: { memberships: true, identities: true } },
    },
  });
  assert.equal(bound.photos.length, 1);
  assert.equal(bound.version, 1);
  assert.equal(bound.status, "DRAFT");
  assert.equal(bound.introduction, t.profile.introduction);
  assert.equal(bound.realNameEncrypted, t.profile.realNameEncrypted);
  assert.equal(bound.serviceCity, t.profile.serviceCity);
  assert.equal(bound.technician.memberships.length, 0);
  assert.equal(bound.technician.identities.length, 0);
  assert.ok(bound.avatarUrl?.includes(t.profile.technicianId));
  assert.ok(!bound.avatarUrl?.includes(s.technicianId));
  assert.equal(
    (await service.targets(principal, org.id, s.technicianId))
      .boundTechnicianId,
    t.profile.technicianId,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: { organizationId: org.id, action: "TECHNICIAN_PHOTO_DRAFT_BOUND" },
    }),
    1,
  );
  await assert.rejects(() =>
    service.bind(principal, org.id, s.technicianId, {
      targetTechnicianId: wechat.profile.technicianId,
      expectedSourceVersion: 1,
      expectedTargetVersion: 0,
    }),
  );
  const otherSource = await source();
  await assert.rejects(() =>
    service.bind(principal, org.id, otherSource.technicianId, {
      targetTechnicianId: t.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 1,
    }),
  );
  const full = await target();
  await prisma.technicianProfile.update({
    where: { id: full.profile.id },
    data: {
      avatarUrl: "https://fixture.invalid/own-avatar",
      galleryUrls: Array.from(
        { length: 12 },
        (_, i) => `https://fixture.invalid/gallery-${i}`,
      ),
    },
  });
  await assert.rejects(() =>
    service.bind(principal, org.id, otherSource.technicianId, {
      targetTechnicianId: full.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 0,
    }),
  );
  assert.equal(
    await prisma.technicianPhoto.count({
      where: { profileId: full.profile.id },
    }),
    0,
  );
  assert.equal(
    await prisma.technicianPhotoDraftBinding.count({
      where: { sourceProfileId: otherSource.id },
    }),
    0,
  );
  const rebound = await target();
  await prisma.user.update({
    where: { id: rebound.profile.technicianId },
    data: { phoneEncrypted: crypto.encrypt("19800000000") },
  });
  await assert.rejects(() =>
    service.bind(principal, org.id, otherSource.technicianId, {
      targetTechnicianId: rebound.profile.technicianId,
      expectedSourceVersion: 0,
      expectedTargetVersion: 0,
    }),
  );
  console.log(
    JSON.stringify({
      passed: true,
      sameOrgOnly: true,
      maskedPhoneOnly: true,
      verifiedIdentityRequired: true,
      wrongAppRejected: true,
      managementAccountsExcluded: true,
      concurrentReplayIdempotent: true,
      existingFieldsPreserved: true,
      photoOwnershipCopied: true,
      noStaffPermissionsGranted: true,
      sourceAndTargetUnique: true,
      staleVersionRejected: true,
      fullGalleryRollsBack: true,
      reboundPhoneRejected: true,
      realMessagesSent: false,
    }),
  );
} finally {
  await prisma.$disconnect();
}

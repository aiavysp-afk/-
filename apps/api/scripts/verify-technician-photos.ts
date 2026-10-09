import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import sharp from "sharp";
import { AccessControlService } from "../src/auth/access-control.service.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { TechnicianPhotoService } from "../src/technicians/technician-photo.service.js";
import { TechniciansService } from "../src/technicians/technicians.service.js";

// Never accepts an arbitrary connection or production database. All portraits
// below are flat-color synthetic images, not user photos or real identities.
const databaseUrl = process.env.PHOTOS_DB_TEST_URL;
if (!databaseUrl) throw new Error("Set PHOTOS_DB_TEST_URL for the dedicated local database");
const target = new URL(databaseUrl);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "55440" || target.pathname !== "/zydj_photos_test" || target.username !== "zydj_photos_test") {
  throw new Error("Only localhost:55440/zydj_photos_test is allowed");
}
const prisma = new PrismaService({ datasourceUrl: databaseUrl });
const config = new ConfigService({ NODE_ENV: "test", TECHNICIAN_PHOTO_PUBLIC_BASE_URL: "https://api.local-photo-test.invalid/v1" });
const processor = new TechnicianPhotoService(config as never);
const service = new TechniciansService(prisma, new AccessControlService(config), processor);
const prefix = `photos-test-${randomUUID()}`;
const organizationIds: string[] = [];
const userIds: string[] = [];
const proof: string[] = [];
const verified = (label: string) => { proof.push(label); process.stdout.write(`PASS ${label}\n`); };
const image = (color: string) => sharp({ create: { width: 180, height: 240, channels: 3, background: color } }).jpeg().toBuffer();

try {
  const organization = await prisma.organization.create({ data: { name: prefix } });
  const other = await prisma.organization.create({ data: { name: `${prefix}-other` } });
  organizationIds.push(organization.id, other.id);
  const technician = await prisma.user.create({ data: { organizationId: organization.id, role: UserRole.THERAPIST, displayName: "SYNTHETIC PRIVATE TEST IDENTITY" } });
  const customer = await prisma.user.create({ data: { organizationId: organization.id, role: UserRole.CUSTOMER, displayName: "SYNTHETIC TEST CUSTOMER" } });
  const admin = await prisma.user.create({ data: { organizationId: organization.id, role: UserRole.OPERATOR, displayName: "SYNTHETIC TEST OPERATOR" } });
  const outsider = await prisma.user.create({ data: { organizationId: other.id, role: UserRole.OPERATOR, displayName: "SYNTHETIC OTHER OPERATOR" } });
  userIds.push(technician.id, customer.id, admin.id, outsider.id);
  await prisma.staffMembership.createMany({ data: [
    { organizationId: organization.id, userId: technician.id, role: UserRole.THERAPIST },
    { organizationId: organization.id, userId: admin.id, role: UserRole.OPERATOR },
    { organizationId: other.id, userId: outsider.id, role: UserRole.OPERATOR },
  ] });
  const principal = (userId: string, role: UserRole, organizationId: string): AuthPrincipal => ({ sessionId: "SYNTHETIC_LOCAL_SESSION", userId, displayName: "PRIVATE", memberships: role === UserRole.CUSTOMER ? [] : [{ organizationId, role }] });
  const own = principal(technician.id, UserRole.THERAPIST, organization.id);
  const manager = principal(admin.id, UserRole.OPERATOR, organization.id);
  const client = principal(customer.id, UserRole.CUSTOMER, organization.id);
  const stranger = principal(outsider.id, UserRole.OPERATOR, other.id);
  const payload = { kind: "AVATAR" as const, base64: (await image("#16ab85")).toString("base64"), authorized: true as const };

  await assert.rejects(() => service.uploadOwnPhoto(client, payload));
  await assert.rejects(() => service.uploadAdminPhoto(stranger, organization.id, technician.id, payload));
  assert.equal(await prisma.technicianPhoto.count(), 0);
  verified("customer and other-organization operator cannot upload or create a photo");

  const draft = await service.getOwnProfile(own);
  assert.equal(draft.publicName, ""); assert.equal(draft.ageRange, null);
  await service.updateOwnProfile(own, { introduction: "Only synthetic test content", specialties: ["SYNTHETIC TEST SERVICE"], publicName: "", ageRange: null });
  const uploaded = await service.uploadOwnPhoto(own, payload);
  assert.equal(uploaded.profile.status, "DRAFT");
  assert.equal(uploaded.profile.publicName, "");
  assert.ok((await service.getOwnPhoto(own, uploaded.photoId)).content.length > 0);
  await assert.rejects(() => service.getPublicPhoto(technician.id, uploaded.photoId));
  await assert.rejects(() => service.getOwnPhoto(client, uploaded.photoId));
  verified("real database stores JPEG bytes; draft visible only through authenticated owner preview, name/age empty");

  await service.submitOwnProfile(own);
  await service.approve(manager, organization.id, technician.id);
  await service.publish(manager, organization.id, technician.id);
  const visible = await service.getPublic(technician.id);
  assert.equal(visible.displayName, "");
  assert.equal(visible.avatarUrl, uploaded.publicUrl);
  assert.equal((await service.getPublicPhoto(technician.id, uploaded.photoId)).id, uploaded.photoId);
  verified("after explicit review and publish, card/detail URL resolves without revealing internal name");

  await service.unpublish(manager, organization.id, technician.id);
  await assert.rejects(() => service.getPublicPhoto(technician.id, uploaded.photoId));
  assert.equal((await service.getAdminPhoto(manager, organization.id, technician.id, uploaded.photoId)).id, uploaded.photoId);
  await assert.rejects(() => service.getAdminPhoto(stranger, organization.id, technician.id, uploaded.photoId));
  verified("unpublish immediately removes public image access, authorized admin preview remains private");

  const oldVersion = (await prisma.technicianProfile.findUniqueOrThrow({ where: { technicianId: technician.id } })).version;
  const adminUpload = await service.uploadAdminPhoto(manager, organization.id, technician.id, payload);
  assert.equal(adminUpload.profile.status, "DRAFT");
  const changed = await prisma.technicianProfile.findUniqueOrThrow({ where: { technicianId: technician.id } });
  assert.equal(changed.version, oldVersion + 1); assert.equal(changed.reviewedById, null); assert.equal(changed.reviewedAt, null);
  await assert.rejects(() => service.approve(manager, organization.id, technician.id));
  await assert.rejects(() => service.publish(manager, organization.id, technician.id));
  await service.submitAdminProfile(manager, organization.id, technician.id);
  await service.approve(manager, organization.id, technician.id);
  await service.publish(manager, organization.id, technician.id);
  assert.equal((await service.getPublicPhoto(technician.id, uploaded.photoId)).id, uploaded.photoId);
  await service.unpublish(manager, organization.id, technician.id);
  verified("admin photo changes invalidate old approval and increment version; fresh scoped submit/review/publish restores visibility");

  const stored = await prisma.technicianPhoto.findUniqueOrThrow({ where: { id: uploaded.photoId } });
  await prisma.technicianPhoto.createMany({ data: Array.from({ length: 22 }, (_, index) => ({
    profileId: stored.profileId,
    digest: createHash("sha256").update(`synthetic-quota-fixture-${index}`).digest("hex"),
    content: stored.content, width: stored.width, height: stored.height, createdAt: new Date(Date.now() - 600_000),
  })) });
  assert.equal(await prisma.technicianPhoto.count({ where: { profileId: stored.profileId } }), 23);
  const [red, blue] = await Promise.all([image("#dd4411"), image("#1144dd")]);
  const attempts = await Promise.allSettled([red, blue].map((buffer) => service.uploadOwnPhoto(own, { kind: "GALLERY", base64: buffer.toString("base64"), authorized: true })));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await prisma.technicianPhoto.count({ where: { profileId: stored.profileId } }), 24);
  verified("two concurrent uploads at23 stored rows yield exactly24; row lock prevents quota bypass");

  const duplicate = await service.uploadOwnPhoto(own, payload);
  assert.equal(duplicate.photoId, uploaded.photoId);
  assert.equal(await prisma.technicianPhoto.count({ where: { profileId: stored.profileId } }), 24);
  assert.equal(duplicate.profile.status, "DRAFT");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: organization.id, action: "TECHNICIAN_PHOTO_SELF_UPLOADED" } });
  assert.ok(!JSON.stringify(audit.metadata).includes(payload.base64));
  verified("re-upload reuses same bytes, resets review status, and audit excludes image payload/PII");

  process.stdout.write(JSON.stringify({ result: "passed", checks: proof.length, syntheticOnly: true, uploadedRealUserPhotos: 0, externalCalls: 0, database: "localhost:55440/zydj_photos_test" }) + "\n");
} finally {
  // Targets are exact IDs returned by this run, not existing rows or broad paths.
  if (organizationIds.length) await prisma.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
  if (userIds.length) {
    await prisma.technicianProfile.deleteMany({ where: { technicianId: { in: userIds } } });
    await prisma.staffMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
}

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { TechnicianPhotoService } from "../src/technicians/technician-photo.service.js";

const directory = process.env.OWNER_PHOTO_IMPORT_DIRECTORY;
const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID;
if (
  !directory ||
  !organizationId ||
  process.env.CONFIRM_OWNER_PHOTO_IMPORT !==
    "first-five-chat-portraits-20261025"
)
  throw new Error(
    "Explicit photo directory, organization and owner confirmation required",
  );
const manifest = JSON.parse(
  readFileSync(join(directory, "manifest.json"), "utf8"),
) as {
  sourceThread: string;
  photos: { number: number; fileName: string; sha256: string }[];
};
if (
  manifest.sourceThread !== "01a10ea2-5ac0-7ab1-a42d-d65d2b57840d" ||
  manifest.photos.length !== 11
)
  throw new Error("Original owner photo provenance required");
const photos = new TechnicianPhotoService(
  new ConfigService({
    TECHNICIAN_PHOTO_PUBLIC_BASE_URL:
      process.env.TECHNICIAN_PHOTO_PUBLIC_BASE_URL || "https://api.mtsc.top/v1",
  }) as never,
);
const prepared = [];
for (const source of manifest.photos.slice(0, 5)) {
  const fileName = `${String(source.number).padStart(2, "0")}.png`;
  if (source.number !== prepared.length + 1 || source.fileName !== fileName)
    throw new Error("Unexpected photo order");
  const file = resolve(directory, fileName);
  if (file !== join(resolve(directory), fileName))
    throw new Error("Invalid source path");
  const original = readFileSync(file);
  if (
    original.length > 8 * 1024 * 1024 ||
    createHash("sha256").update(original).digest("hex") !== source.sha256
  )
    throw new Error("Original photo digest mismatch");
  // Same bounded transport preparation as the client upload; the canonical
  // photo service then validates and normalizes the bytes stored in the DB.
  const upload = await sharp(original, {
    limitInputPixels: 16_000_000,
    failOn: "warning",
  })
    .rotate()
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  const normalized = await photos.normalize(upload.toString("base64"));
  prepared.push({ source, normalized });
}
const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
      const drafts = [];
      for (const { source, normalized } of prepared) {
        const suffix = String(source.number).padStart(2, "0");
        const userId = `owner-photo-draft-20261025-${suffix}`;
        const existing = await tx.user.findUnique({
          where: { id: userId },
          include: {
            technicianProfile: {
              include: { photos: { select: { digest: true } } },
            },
          },
        });
        if (existing) {
          if (
            existing.organizationId !== organizationId ||
            existing.technicianProfile?.registrationChannel !==
              "ADMIN_PHOTO_DRAFT" ||
            !existing.technicianProfile.photos.some(
              (photo) => photo.digest === normalized.digest,
            )
          )
            throw new Error("Existing draft differs; refusing overwrite");
          drafts.push({
            sourceNumber: source.number,
            technicianId: userId,
            created: false,
          });
          continue;
        }
        const photoId = randomUUID();
        await tx.user.create({
          data: {
            id: userId,
            organizationId,
            role: "CUSTOMER",
            displayName: `照片预建档 ${suffix}`,
            technicianProfile: {
              create: {
                organizationId,
                selfRegistered: false,
                registrationChannel: "ADMIN_PHOTO_DRAFT",
                status: "DRAFT",
                publicName: "",
                ageRange: null,
                introduction: "",
                serviceCity: "",
                specialties: [],
                serviceAreas: [],
                availableTimeSlots: [],
                serviceIds: [],
                avatarUrl: photos.publicUrl(userId, photoId),
                galleryUrls: [],
                photos: { create: { id: photoId, ...normalized } },
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            action: "TECHNICIAN_OWNER_PHOTO_DRAFT_CREATED",
            resourceType: "TechnicianProfile",
            resourceId: userId,
            metadata: {
              source: "owner-approved-chat-portraits",
              sourceThread: manifest.sourceThread,
              sourceOrder: source.number,
              sourceSha256: source.sha256,
              storedDigest: normalized.digest,
              membershipGranted: false,
              fieldsLeftBlank: true,
            },
          },
        });
        drafts.push({
          sourceNumber: source.number,
          technicianId: userId,
          created: true,
        });
      }
      return {
        imported: drafts.length,
        drafts,
        status: "DRAFT",
        personalInformationLeftBlank: true,
      };
    },
    { timeout: 20000 },
  );
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}

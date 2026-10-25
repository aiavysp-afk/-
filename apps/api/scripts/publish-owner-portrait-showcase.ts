// Explicit, bounded owner request: publish only the first five recovered portraits.
// Does not change application status, identities, memberships, services or shifts.
import { PrismaClient } from "@prisma/client";
if (
  process.env.CONFIRM_OWNER_PORTRAIT_SHOWCASE !==
  "first-five-chat-portraits-20261025"
)
  throw new Error("Explicit owner portrait publication confirmation required");
const org = "org-zhongyuan-production";
const ids = Array.from(
  { length: 5 },
  (_, i) => `owner-photo-draft-20261025-${String(i + 1).padStart(2, "0")}`,
);
const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "technicianId" IN (${ids[0]},${ids[1]},${ids[2]},${ids[3]},${ids[4]}) ORDER BY "id" FOR UPDATE`;
    const rows = await tx.technicianProfile.findMany({
      where: { technicianId: { in: ids } },
      include: {
        photos: { select: { id: true, digest: true } },
        photoDraftBinding: true,
      },
    });
    if (rows.length !== 5)
      throw new Error("Exactly five owner photo drafts required");
    let changed = 0;
    for (const row of rows) {
      if (
        row.organizationId !== org ||
        row.registrationChannel !== "ADMIN_PHOTO_DRAFT" ||
        row.status !== "DRAFT" ||
        row.photoDraftBinding
      )
        throw new Error("Owner draft changed; publication refused");
      const provenance = await tx.auditLog.findFirst({
        where: {
          organizationId: org,
          resourceId: row.technicianId,
          action: "TECHNICIAN_OWNER_PHOTO_DRAFT_CREATED",
        },
      });
      if (!provenance) throw new Error("Owner import provenance required");
      const path = row.avatarUrl ? new URL(row.avatarUrl).pathname : "";
      const photo = row.photos.find(
        (p) =>
          path ===
          `/v1/technicians/${encodeURIComponent(row.technicianId)}/photos/${p.id}`,
      );
      const metadata = provenance.metadata as { storedDigest?: string };
      if (!photo || metadata.storedDigest !== photo.digest)
        throw new Error("Original imported avatar required");
      if (row.showcasePhotoId === photo.id) continue;
      await tx.technicianProfile.update({
        where: { id: row.id },
        data: { showcasePhotoId: photo.id, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          organizationId: org,
          action: "TECHNICIAN_PORTRAIT_SHOWCASE_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: row.id,
          metadata: {
            enabled: true,
            source: "owner-chat-request-20261025",
            bookingAccessGranted: false,
          },
        },
      });
      changed++;
    }
    // Reset the old client's prematurely consumed daily impression once.
    await tx.$queryRaw`SELECT "organizationId" FROM "HomeCampaign" WHERE "organizationId" = ${org} FOR UPDATE`;
    const campaign = await tx.homeCampaign.findUniqueOrThrow({
      where: { organizationId: org },
    });
    if (campaign.version === 1) {
      await tx.homeCampaign.update({
        where: { organizationId: org },
        data: { version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          organizationId: org,
          action: "HOME_CAMPAIGN_DISPLAY_REFRESHED",
          resourceType: "HomeCampaign",
          resourceId: org,
          metadata: { version: 2, reason: "client-impression-lifecycle-fix" },
        },
      });
    }
    return {
      portraits: 5,
      changed,
      applicationsApproved: 0,
      bookingAccessGranted: false,
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}

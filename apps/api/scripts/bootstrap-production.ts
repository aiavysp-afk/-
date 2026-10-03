import { PrismaClient } from "@prisma/client";
import { serviceCatalog } from "../src/catalog/catalog.data.js";

// Explicit, reviewed operation. Existing real WeChat identities must already exist.
if (
  process.env.NODE_ENV !== "production" ||
  process.env.CONFIRM_PRODUCTION_BOOTSTRAP !== "true"
)
  throw new Error("Production bootstrap requires explicit confirmation");
const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID;
const requesterId = process.env.BOOTSTRAP_REFUND_REQUESTER_USER_ID;
const approverId = process.env.BOOTSTRAP_REFUND_APPROVER_USER_ID;
if (
  !organizationId ||
  !requesterId ||
  !approverId ||
  requesterId === approverId
)
  throw new Error("Provide organization and two distinct verified user IDs");
const prisma = new PrismaClient();
try {
  await prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({
      where: { id: { in: [requesterId, approverId] }, status: "ACTIVE" },
      include: { identities: true },
    });
    if (users.length !== 2 || users.some((user) => !user.identities.length))
      throw new Error("Both reviewers need active verified WeChat accounts");
    await tx.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: { id: organizationId, name: "中原到家" },
    });
    for (const [userId, role] of [
      [requesterId, "FINANCE_REQUESTER"],
      [approverId, "FINANCE_APPROVER"],
    ] as const) {
      await tx.staffMembership.upsert({
        where: { userId_organizationId_role: { userId, organizationId, role } },
        update: { status: "ACTIVE" },
        create: { userId, organizationId, role },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          action: "PRODUCTION_FINANCE_MEMBERSHIP_BOOTSTRAP",
          resourceType: "User",
          resourceId: userId,
          metadata: { role },
        },
      });
    }
    for (const item of serviceCatalog) {
      const existing = await tx.service.findUnique({
        where: { slug: item.slug },
      });
      if (existing && existing.organizationId !== organizationId)
        throw new Error(
          "Catalog slug belongs to another organization; manual review required",
        );
      if (!existing)
        await tx.service.create({
          data: {
            organizationId,
            slug: item.slug,
            name: item.name,
            category: item.category,
            subtitle: item.subtitle,
            description: item.description,
            durationMinutes: item.durationMinutes,
            priceFen: BigInt(item.priceFen),
            steps: item.steps,
            boundaries: item.boundaries,
            published: false,
          },
        });
    }
  });
  console.log(
    "Organization and distinct finance memberships initialized; new services remain unpublished",
  );
} finally {
  await prisma.$disconnect();
}

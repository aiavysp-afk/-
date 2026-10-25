import { PrismaClient } from "@prisma/client";

// Initialize only the owner-requested campaign. Existing staff, applicants and
// campaign configuration are preserved on repeated runs.
const prisma = new PrismaClient();
const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID;
if (
  !organizationId ||
  process.env.CONFIRM_HOME_CAMPAIGN_BOOTSTRAP !== "20261025-newcomer-campaign"
)
  throw new Error("Explicit organization and campaign confirmation required");

try {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    const existing = await tx.homeCampaign.findUnique({
      where: { organizationId },
    });
    if (existing) return { initialized: false, version: existing.version };
    await tx.homeCampaign.create({
      data: {
        organizationId,
        version: 1,
        content: {
          enabled: true,
          title: "新人专享 · 先领券再预约",
          body: "40元券：仅项目费满498元可用\n30元券：仅项目费满398元可用\n另含20元、10元项目优惠券。以券面规则为准。",
          buttonText: "查看新人优惠",
          target: "COUPONS",
          frequency: "DAILY",
          startsAt: null,
          endsAt: null,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId,
        action: "HOME_CAMPAIGN_INITIALIZED",
        resourceType: "HomeCampaign",
        resourceId: organizationId,
        metadata: { source: "owner-request-20261025", version: 1 },
      },
    });
    return { initialized: true, organization: organization.name, version: 1 };
  });
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}

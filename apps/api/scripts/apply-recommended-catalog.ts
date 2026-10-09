import { PrismaClient } from "@prisma/client";
import {
  applyRecommendedCatalog,
  assertRecommendedCatalogTarget,
  planRecommendedCatalog,
  recommendedCatalog,
  RECOMMENDED_CATALOG_ORGANIZATION_ID,
} from "../src/catalog/recommended-catalog.js";

const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  throw new Error("Only --apply is supported; omit it for a read-only preview");
}
assertRecommendedCatalogTarget(process.env);
if (apply && process.env.CONFIRM_RECOMMENDED_CATALOG !== "mtsc.top") {
  throw new Error(
    "Applying the recommended catalog requires explicit confirmation",
  );
}

const prisma = new PrismaClient();
const organizationId = RECOMMENDED_CATALOG_ORGANIZATION_ID;

try {
  const summary = await prisma.$transaction(async (tx) => {
    if (apply) {
      // Serializes this scoped patch with concurrent catalog patches in this organization.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
      `;
      if (rows.length !== 1)
        throw new Error("Existing production organization is missing");
    } else {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
      });
      if (!organization)
        throw new Error("Existing production organization is missing");
    }
    const existing = await tx.service.findMany({
      where: {
        OR: [
          { id: { in: recommendedCatalog.map((item) => item.id) } },
          { slug: { in: recommendedCatalog.map((item) => item.slug) } },
          {
            organizationId,
            name: { in: recommendedCatalog.map((item) => item.name) },
          },
        ],
      },
    });
    const plan = planRecommendedCatalog(existing, organizationId);
    if (apply) await applyRecommendedCatalog(tx, plan, organizationId);
    return plan.map((item) => ({
      action: item.action,
      id: item.id,
      slug: item.slug,
      name: item.content.name,
      priceFen: Number(item.content.priceFen),
      durationMinutes: item.content.durationMinutes,
      changedFields: item.changedFields,
    }));
  });
  console.log(
    JSON.stringify({
      organizationId,
      mode: apply ? "APPLIED" : "READ_ONLY",
      services: summary,
    }),
  );
} catch {
  // Prisma errors may contain connection strings; report only a fixed, non-secret message.
  console.error(
    "Recommended catalog was not applied; check the local database and scoped catalog conflicts",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

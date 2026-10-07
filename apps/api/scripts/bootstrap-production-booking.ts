import {
  MembershipStatus,
  PrismaClient,
  ServiceCategory,
  ShiftStatus,
  UserRole,
} from "@prisma/client";
import { serviceCatalog } from "../src/catalog/catalog.data.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const target = new URL(databaseUrl);
if (
  process.env.NODE_ENV !== "production" ||
  process.env.CONFIRM_PUBLIC_BOOKING_BOOTSTRAP !== "mtsc.top" ||
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/zhongyuan_daojia"
) {
  throw new Error("Refusing unconfirmed or unexpected production bootstrap");
}

const shiftDays = Number(process.env.PUBLIC_BOOKING_SHIFT_DAYS ?? "30");
if (!Number.isInteger(shiftDays) || shiftDays < 7 || shiftDays > 90) {
  throw new Error("PUBLIC_BOOKING_SHIFT_DAYS must be an integer from 7 to 90");
}

const prisma = new PrismaClient();
const organizationId = "org-zhongyuan-production";
const schedulerId = "user-public-booking-scheduler";
const capacityId = "user-public-booking-capacity";

const shanghaiDate = (offsetDays: number) => {
  const local = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  local.setUTCDate(local.getUTCDate() + offsetDays);
  return [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, "0"),
    String(local.getUTCDate()).padStart(2, "0"),
  ].join("-");
};

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.organization.upsert({
      where: { id: organizationId },
      update: { name: "中原到家" },
      create: { id: organizationId, name: "中原到家" },
    });

    for (const item of serviceCatalog) {
      await tx.service.upsert({
        where: { slug: item.slug },
        update: {
          organizationId,
          name: item.name,
          category: ServiceCategory[item.category],
          subtitle: item.subtitle,
          badge: item.badge,
          description: item.description,
          durationMinutes: item.durationMinutes,
          priceFen: BigInt(item.priceFen),
          featured: item.featured,
          published: true,
          steps: item.steps,
          boundaries: item.boundaries,
        },
        create: {
          id: item.id,
          organizationId,
          slug: item.slug,
          name: item.name,
          category: ServiceCategory[item.category],
          subtitle: item.subtitle,
          badge: item.badge,
          description: item.description,
          durationMinutes: item.durationMinutes,
          priceFen: BigInt(item.priceFen),
          featured: item.featured,
          published: true,
          steps: item.steps,
          boundaries: item.boundaries,
        },
      });
    }

    for (const user of [
      {
        id: schedulerId,
        role: UserRole.DISPATCHER,
        displayName: "公开预约系统",
      },
      {
        id: capacityId,
        role: UserRole.THERAPIST,
        displayName: "待人工分配技师",
      },
    ]) {
      await tx.user.upsert({
        where: { id: user.id },
        update: {
          organizationId,
          role: user.role,
          displayName: user.displayName,
          status: "ACTIVE",
        },
        create: {
          id: user.id,
          organizationId,
          role: user.role,
          displayName: user.displayName,
          status: "ACTIVE",
        },
      });
      await tx.staffMembership.upsert({
        where: {
          userId_organizationId_role: {
            userId: user.id,
            organizationId,
            role: user.role,
          },
        },
        update: { status: MembershipStatus.ACTIVE },
        create: {
          userId: user.id,
          organizationId,
          role: user.role,
          status: MembershipStatus.ACTIVE,
        },
      });
    }

    for (let offset = 1; offset <= shiftDays; offset += 1) {
      const date = shanghaiDate(offset);
      await tx.therapistShift.upsert({
        where: { id: `shift-public-capacity-${date}` },
        update: {
          startsAt: new Date(`${date}T10:00:00+08:00`),
          endsAt: new Date(`${date}T22:00:00+08:00`),
          status: ShiftStatus.ACTIVE,
          createdById: schedulerId,
        },
        create: {
          id: `shift-public-capacity-${date}`,
          organizationId,
          therapistId: capacityId,
          startsAt: new Date(`${date}T10:00:00+08:00`),
          endsAt: new Date(`${date}T22:00:00+08:00`),
          status: ShiftStatus.ACTIVE,
          createdById: schedulerId,
        },
      });
    }
  });

  console.log(
    JSON.stringify({
      organizationId,
      publishedServices: serviceCatalog.length,
      capacityIdentity: "non-login scheduling placeholder",
      shiftDays,
      realPaymentsEnabled: false,
    }),
  );
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

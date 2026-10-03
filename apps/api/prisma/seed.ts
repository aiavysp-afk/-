import { ConfigService } from "@nestjs/config";
import {
  IdentityProvider,
  MembershipStatus,
  PrismaClient,
  ServiceCategory,
  UserRole,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { serviceCatalog } from "../src/catalog/catalog.data.js";
import type { AppEnv } from "../src/config/env.js";

const prisma = new PrismaClient();

async function main() {
  const organization = await prisma.organization.upsert({
    where: { id: "org-zhongyuan-pilot" },
    update: { name: "中原到家（试运营）" },
    create: { id: "org-zhongyuan-pilot", name: "中原到家（试运营）" },
  });

  for (const item of serviceCatalog) {
    await prisma.service.upsert({
      where: { slug: item.slug },
      update: {
        name: item.name,
        category: ServiceCategory[item.category],
        subtitle: item.subtitle,
        badge: item.badge,
        description: item.description,
        durationMinutes: item.durationMinutes,
        priceFen: BigInt(item.priceFen),
        featured: item.featured,
        steps: item.steps,
        boundaries: item.boundaries,
      },
      create: {
        id: item.id,
        organizationId: organization.id,
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

  if (process.env.SEED_DEVELOPMENT_IDENTITIES === "true") {
    const config = new ConfigService({
      AUTH_SESSION_PEPPER:
        process.env.AUTH_SESSION_PEPPER ??
        "local-only-session-pepper-change-before-production",
      DATA_ENCRYPTION_KEY_BASE64:
        process.env.DATA_ENCRYPTION_KEY_BASE64 ??
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }) as ConfigService<AppEnv, true>;
    const crypto = new AuthCryptoService(config);
    const appId = process.env.WECHAT_MINIAPP_APP_ID ?? "wxab76ea213eb6d01a";
    const developmentCode = "local-catalog-operator";
    const openId = `mock-${createHash("sha256").update(developmentCode).digest("hex").slice(0, 32)}`;
    const subjectHash = crypto.hashIdentity(appId, openId);
    const user = await prisma.user.upsert({
      where: { id: "user-local-catalog-operator" },
      update: { displayName: "本地目录运营", status: "ACTIVE" },
      create: {
        id: "user-local-catalog-operator",
        role: UserRole.OPERATOR,
        displayName: "本地目录运营",
      },
    });
    await prisma.staffMembership.upsert({
      where: {
        userId_organizationId_role: {
          userId: user.id,
          organizationId: organization.id,
          role: UserRole.OPERATOR,
        },
      },
      update: { status: MembershipStatus.ACTIVE },
      create: {
        userId: user.id,
        organizationId: organization.id,
        role: UserRole.OPERATOR,
        status: MembershipStatus.ACTIVE,
      },
    });
    await prisma.externalIdentity.upsert({
      where: {
        provider_subjectHash: {
          provider: IdentityProvider.WECHAT_MINIAPP,
          subjectHash,
        },
      },
      update: { userId: user.id },
      create: {
        userId: user.id,
        provider: IdentityProvider.WECHAT_MINIAPP,
        subjectHash,
        subjectEncrypted: crypto.encrypt(openId),
      },
    });
    console.log("Seeded explicit local-only catalog operator identity");

    const dispatcherCode = "local-scheduling-dispatcher";
    const dispatcherOpenId = `mock-${createHash("sha256").update(dispatcherCode).digest("hex").slice(0, 32)}`;
    const dispatcherSubjectHash = crypto.hashIdentity(appId, dispatcherOpenId);
    const dispatcher = await prisma.user.upsert({
      where: { id: "user-local-scheduling-dispatcher" },
      update: { displayName: "本地排班调度", status: "ACTIVE" },
      create: {
        id: "user-local-scheduling-dispatcher",
        role: UserRole.DISPATCHER,
        displayName: "本地排班调度",
      },
    });
    await prisma.staffMembership.upsert({
      where: {
        userId_organizationId_role: {
          userId: dispatcher.id,
          organizationId: organization.id,
          role: UserRole.DISPATCHER,
        },
      },
      update: { status: MembershipStatus.ACTIVE },
      create: {
        userId: dispatcher.id,
        organizationId: organization.id,
        role: UserRole.DISPATCHER,
        status: MembershipStatus.ACTIVE,
      },
    });
    await prisma.externalIdentity.upsert({
      where: {
        provider_subjectHash: {
          provider: IdentityProvider.WECHAT_MINIAPP,
          subjectHash: dispatcherSubjectHash,
        },
      },
      update: { userId: dispatcher.id },
      create: {
        userId: dispatcher.id,
        provider: IdentityProvider.WECHAT_MINIAPP,
        subjectHash: dispatcherSubjectHash,
        subjectEncrypted: crypto.encrypt(dispatcherOpenId),
      },
    });

    const therapist = await prisma.user.upsert({
      where: { id: "user-local-therapist-anran" },
      update: { displayName: "安然（本地演示）", status: "ACTIVE" },
      create: {
        id: "user-local-therapist-anran",
        role: UserRole.THERAPIST,
        displayName: "安然（本地演示）",
      },
    });
    await prisma.staffMembership.upsert({
      where: {
        userId_organizationId_role: {
          userId: therapist.id,
          organizationId: organization.id,
          role: UserRole.THERAPIST,
        },
      },
      update: { status: MembershipStatus.ACTIVE },
      create: {
        userId: therapist.id,
        organizationId: organization.id,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
    });

    const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1_000);
    const tomorrow = new Date(
      Date.UTC(
        shanghaiNow.getUTCFullYear(),
        shanghaiNow.getUTCMonth(),
        shanghaiNow.getUTCDate() + 1,
      ),
    );
    const date = [
      tomorrow.getUTCFullYear(),
      String(tomorrow.getUTCMonth() + 1).padStart(2, "0"),
      String(tomorrow.getUTCDate()).padStart(2, "0"),
    ].join("-");
    await prisma.therapistShift.upsert({
      where: { id: "shift-local-anran-tomorrow" },
      update: {
        startsAt: new Date(`${date}T10:00:00+08:00`),
        endsAt: new Date(`${date}T18:00:00+08:00`),
        status: "ACTIVE",
        createdById: dispatcher.id,
      },
      create: {
        id: "shift-local-anran-tomorrow",
        organizationId: organization.id,
        therapistId: therapist.id,
        startsAt: new Date(`${date}T10:00:00+08:00`),
        endsAt: new Date(`${date}T18:00:00+08:00`),
        createdById: dispatcher.id,
      },
    });
    console.log(
      "Seeded explicit local-only scheduling identities and tomorrow shift",
    );
  }

  console.log(
    `Seeded ${serviceCatalog.length} services for ${organization.name}`,
  );
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

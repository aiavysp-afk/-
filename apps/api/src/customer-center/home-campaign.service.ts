import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HomeCampaignContentSchema,
  type HomeCampaignContent,
  type HomeCampaignSave,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { TechnicianPhotoService } from "../technicians/technician-photo.service.js";

export const DEFAULT_CAMPAIGN: HomeCampaignContent = {
  enabled: false,
  title: "欢迎来到中原到家",
  body: "新人专享项目优惠券，先领券再预约。具体使用门槛以优惠券说明为准。",
  buttonText: "查看新人优惠",
  target: "COUPONS",
  frequency: "DAILY",
  startsAt: null,
  endsAt: null,
};
export function campaignActive(content: HomeCampaignContent, now = Date.now()) {
  return (
    content.enabled &&
    (!content.startsAt || Date.parse(content.startsAt) <= now) &&
    (!content.endsAt || Date.parse(content.endsAt) > now)
  );
}
type Row = {
  organizationId: string;
  version: number;
  content: unknown;
  imageBytes: Uint8Array | null;
};
export function campaignView(row: Row) {
  return {
    ...HomeCampaignContentSchema.parse(row.content),
    organizationId: row.organizationId,
    version: row.version,
    imagePath: row.imageBytes
      ? `/campaigns/home/image/${encodeURIComponent(row.organizationId)}/${row.version}`
      : null,
  };
}

@Injectable()
export class HomeCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly photos: TechnicianPhotoService,
  ) {}

  async admin(principal: AuthPrincipal, organizationId: string) {
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
    const row = await this.prisma.homeCampaign.findUnique({
      where: { organizationId },
    });
    return row
      ? {
          ...campaignView(row),
          imageDataUrl: row.imageBytes
            ? `data:image/jpeg;base64,${Buffer.from(row.imageBytes).toString("base64")}`
            : null,
        }
      : {
          ...DEFAULT_CAMPAIGN,
          organizationId,
          version: 0,
          imagePath: null,
          imageDataUrl: null,
        };
  }

  async save(
    principal: AuthPrincipal,
    organizationId: string,
    input: HomeCampaignSave,
  ) {
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
    const image =
      input.imageBase64 === undefined
        ? undefined
        : input.imageBase64 === null
          ? null
          : (await this.photos.normalize(input.imageBase64)).content;
    const { expectedVersion, imageBase64: _, ...content } = input;
    await this.prisma.$transaction(async (tx) => {
      // Lock the existing parent so concurrent first saves cannot both create version 1.
      const orgs = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
      if (!orgs.length) throw new NotFoundException("服务组织不存在");
      const current = await tx.homeCampaign.findUnique({
        where: { organizationId },
      });
      if ((current?.version ?? 0) !== expectedVersion)
        throw new ConflictException("活动已被其他人修改，请刷新后再保存");
      await tx.homeCampaign.upsert({
        where: { organizationId },
        create: {
          organizationId,
          version: 1,
          content,
          imageBytes: image ?? null,
        },
        update: {
          version: { increment: 1 },
          content,
          ...(image === undefined ? {} : { imageBytes: image }),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "HOME_CAMPAIGN_UPDATED",
          resourceType: "HomeCampaign",
          resourceId: organizationId,
          metadata: { enabled: content.enabled, version: expectedVersion + 1 },
        },
      });
    });
    return this.admin(principal, organizationId);
  }

  async current() {
    // Matches the customer-center default organization, not a random campaign from another tenant.
    const service = await this.prisma.service.findFirst({
      where: { published: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { organizationId: true },
    });
    if (!service) return null;
    const row = await this.prisma.homeCampaign.findUnique({
      where: { organizationId: service.organizationId },
    });
    if (!row) return null;
    const view = campaignView(row);
    return campaignActive(view) ? view : null;
  }

  async image(organizationId: string, version: number) {
    const current = await this.current();
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.version !== version
    )
      throw new NotFoundException();
    const row = await this.prisma.homeCampaign.findUnique({
      where: { organizationId },
    });
    if (
      !row?.imageBytes ||
      row.version !== version ||
      !campaignActive(campaignView(row))
    )
      throw new NotFoundException();
    return Buffer.from(row.imageBytes);
  }
}

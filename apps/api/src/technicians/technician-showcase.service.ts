import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  TechnicianShowcaseSave,
  TechnicianShowcasePortrait,
} from "@zydj/contracts";
import { PrismaService } from "../database/prisma.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";

@Injectable()
export class TechnicianShowcaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  private async organization() {
    return (
      await this.prisma.service.findFirst({
        where: { published: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { organizationId: true },
      })
    )?.organizationId;
  }
  private visible(organizationId: string) {
    return {
      organizationId,
      registrationChannel: "ADMIN_PHOTO_DRAFT",
      status: "DRAFT" as const,
      showcasePhotoId: { not: null },
      photoDraftBinding: null,
      technician: { status: "ACTIVE" as const },
    };
  }
  async list(): Promise<TechnicianShowcasePortrait[]> {
    const organizationId = await this.organization();
    if (!organizationId) return [];
    const rows = await this.prisma.technicianProfile.findMany({
      where: this.visible(organizationId),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { showcasePhotoId: true, photos: { select: { id: true } } },
    });
    // Return only the individually selected portrait, never identity documents,
    // unpublished gallery photos, real names, account IDs, or contact details.
    return rows
      .filter((row) =>
        row.photos.some((photo) => photo.id === row.showcasePhotoId),
      )
      .slice(0, 20)
      .map((row) => ({
        id: row.showcasePhotoId!,
        imagePath: `/technician-showcase/photos/${encodeURIComponent(row.showcasePhotoId!)}`,
      }));
  }
  async image(photoId: string) {
    const organizationId = await this.organization();
    if (!organizationId) throw new NotFoundException();
    const photo = await this.prisma.technicianPhoto.findFirst({
      where: {
        id: photoId,
        profile: { ...this.visible(organizationId), showcasePhotoId: photoId },
      },
      select: { content: true },
    });
    if (!photo) throw new NotFoundException();
    return Buffer.from(photo.content);
  }
  async save(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: TechnicianShowcaseSave,
  ) {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "organizationId" = ${organizationId} AND "technicianId" = ${technicianId} FOR UPDATE`;
      const profile = await tx.technicianProfile.findFirst({
        where: {
          organizationId,
          technicianId,
          registrationChannel: "ADMIN_PHOTO_DRAFT",
        },
        include: { photos: { select: { id: true } }, photoDraftBinding: true },
      });
      if (!profile) throw new NotFoundException("照片预建档不存在");
      if (profile.version !== input.expectedVersion)
        throw new ConflictException("资料已更新，请刷新后重试");
      let photoId: string | null = null;
      if (input.enabled) {
        if (profile.status !== "DRAFT" || profile.photoDraftBinding)
          throw new ConflictException(
            "该档案已进入本人申请流程，请使用本人公开资料",
          );
        const path = profile.avatarUrl
          ? new URL(profile.avatarUrl).pathname
          : "";
        photoId =
          profile.photos.find(
            (photo) =>
              path ===
              `/v1/technicians/${encodeURIComponent(technicianId)}/photos/${encodeURIComponent(photo.id)}`,
          )?.id ?? null;
        if (!photoId)
          throw new ConflictException("请先上传并保存该档案的个人头像");
      }
      if (profile.showcasePhotoId === photoId)
        return { enabled: Boolean(photoId), version: profile.version };
      const updated = await tx.technicianProfile.update({
        where: { id: profile.id },
        data: { showcasePhotoId: photoId, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_PORTRAIT_SHOWCASE_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: profile.id,
          metadata: { enabled: Boolean(photoId), bookingAccessGranted: false },
        },
      });
      return { enabled: Boolean(photoId), version: updated.version };
    });
  }
}

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  TechnicianPhotoDraftBind,
  TechnicianPhotoDraftTargets,
} from "@zydj/contracts";
import { PrismaService } from "../database/prisma.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import {
  TechnicianPhotoService,
  MAX_TECHNICIAN_PHOTO_COUNT,
} from "./technician-photo.service.js";

const candidateInclude = {
  technician: {
    include: {
      customerPhoneIdentity: true,
      identities: true,
      memberships: true,
    },
  },
} satisfies Prisma.TechnicianProfileInclude;
const targetInclude = {
  ...candidateInclude,
  photos: true,
} satisfies Prisma.TechnicianProfileInclude;
type Candidate = Prisma.TechnicianProfileGetPayload<{
  include: typeof candidateInclude;
}>;
const strings = (value: Prisma.JsonValue) =>
  Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];

@Injectable()
export class TechnicianPhotoDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
    private readonly photos: TechnicianPhotoService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private eligible(target: Candidate) {
    const user = target.technician;
    if (
      !target.selfRegistered ||
      !["DRAFT", "REJECTED"].includes(target.status) ||
      user.status !== "ACTIVE" ||
      !["CUSTOMER", "THERAPIST"].includes(user.role) ||
      !user.phoneEncrypted ||
      !user.phoneVerifiedAt ||
      user.memberships.some(
        (m) =>
          m.role !== "THERAPIST" ||
          m.status !== "ACTIVE" ||
          m.organizationId !== target.organizationId,
      )
    )
      return false;
    try {
      const phone = this.crypto.decrypt(user.phoneEncrypted);
      if (!/^1[3-9]\d{9}$/.test(phone)) return false;
      if (target.registrationChannel === "TECHNICIAN_PHONE")
        return (
          user.customerPhoneIdentity?.phoneHash ===
          this.crypto.hashPhoneVerification("phone", phone)
        );
      if (target.registrationChannel === "WECHAT_MINIAPP")
        return user.identities.some(
          (identity) =>
            identity.provider === "WECHAT_MINIAPP" &&
            identity.subjectHash ===
              this.crypto.hashIdentity(
                this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
                this.crypto.decrypt(identity.subjectEncrypted),
              ),
        );
      return (
        target.registrationChannel === "WECHAT_H5" &&
        user.identities.some(
          (identity) =>
            identity.provider === "WECHAT_H5" && Boolean(identity.unionIdHash),
        )
      );
    } catch {
      return false;
    }
  }
  private async source(organizationId: string, technicianId: string) {
    const source = await this.prisma.technicianProfile.findFirst({
      where: {
        organizationId,
        technicianId,
        registrationChannel: "ADMIN_PHOTO_DRAFT",
        technician: { status: "ACTIVE" },
      },
      include: {
        photoDraftBinding: {
          include: {
            targetProfile: {
              select: { organizationId: true, technicianId: true },
            },
          },
        },
      },
    });
    if (!source) throw new NotFoundException("照片预建档不存在");
    if (
      source.photoDraftBinding?.targetProfile.organizationId &&
      source.photoDraftBinding.targetProfile.organizationId !== organizationId
    )
      throw new ConflictException("照片关联记录需由平台核查");
    return source;
  }
  async targets(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianPhotoDraftTargets> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const source = await this.source(organizationId, technicianId);
    if (source.photoDraftBinding)
      return {
        boundTechnicianId: source.photoDraftBinding.targetProfile.technicianId,
        targets: [],
      };
    const candidates = await this.prisma.technicianProfile.findMany({
      where: {
        organizationId,
        selfRegistered: true,
        status: { in: ["DRAFT", "REJECTED"] },
        receivedPhotoDraft: null,
        technician: { status: "ACTIVE", phoneVerifiedAt: { not: null } },
      },
      include: candidateInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 100,
    });
    return {
      boundTechnicianId: null,
      targets: candidates
        .filter((row) => this.eligible(row))
        .map((row) => {
          const phone = this.crypto.decrypt(row.technician.phoneEncrypted!);
          let label = row.publicName;
          if (!label && row.realNameEncrypted) {
            const name = this.crypto.decryptScoped(
              `technician-real-name:${row.id}`,
              row.realNameEncrypted,
            );
            label =
              name.length <= 1
                ? "*"
                : `${name[0]}${"*".repeat(Math.min(name.length - 1, 3))}`;
          }
          return {
            technicianId: row.technicianId,
            version: row.version,
            label: label || "本人入驻申请",
            phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
          };
        }),
    };
  }

  async bind(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: TechnicianPhotoDraftBind,
  ) {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const initial = await this.source(organizationId, technicianId);
    const target = await this.prisma.technicianProfile.findFirst({
      where: { organizationId, technicianId: input.targetTechnicianId },
      select: { id: true },
    });
    if (!target || target.id === initial.id)
      throw new NotFoundException("请选择同一组织的本人入驻申请");
    return this.prisma.$transaction(
      async (tx) => {
        // Match account/approval operations: identity first, profile snapshots next.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.targetTechnicianId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "id" IN (${initial.id},${target.id}) ORDER BY "id" FOR UPDATE`;
        const source = await tx.technicianProfile.findUniqueOrThrow({
          where: { id: initial.id },
          include: {
            photos: true,
            photoDraftBinding: {
              include: { targetProfile: { select: { technicianId: true } } },
            },
          },
        });
        const destination = await tx.technicianProfile.findUniqueOrThrow({
          where: { id: target.id },
          include: targetInclude,
        });
        if (
          source.organizationId !== organizationId ||
          destination.organizationId !== organizationId ||
          source.registrationChannel !== "ADMIN_PHOTO_DRAFT"
        )
          throw new ForbiddenException("资料组织不匹配");
        if (source.photoDraftBinding) {
          if (source.photoDraftBinding.targetProfileId !== destination.id)
            throw new ConflictException("这份照片已关联其他技师，不能重复分配");
          return {
            sourceTechnicianId: technicianId,
            targetTechnicianId: input.targetTechnicianId,
            idempotentReplay: true,
          };
        }
        // Lock identity/account changes as well as the two application snapshots.
        const latest = await tx.technicianProfile.findUniqueOrThrow({
          where: { id: destination.id },
          include: targetInclude,
        });
        if (
          source.status !== "DRAFT" ||
          source.version !== input.expectedSourceVersion ||
          latest.version !== input.expectedTargetVersion
        )
          throw new ConflictException("照片或入驻资料已变化，请刷新后重新选择");
        if (!this.eligible(latest))
          throw new ForbiddenException(
            "目标须为已完成本人手机验证的技师入驻草稿，且不能是管理账号",
          );
        if (
          await tx.technicianPhotoDraftBinding.findUnique({
            where: { targetProfileId: latest.id },
          })
        )
          throw new ConflictException("该技师已关联另一份照片预建档");
        const visible = new Set(
          [source.avatarUrl, ...strings(source.galleryUrls)].filter(
            (x): x is string => Boolean(x),
          ),
        );
        const originals = source.photos.filter((photo) =>
          visible.has(this.photos.publicUrl(source.technicianId, photo.id)),
        );
        if (!originals.length)
          throw new ConflictException("预建档没有选中的照片");
        const existingByDigest = new Map(
          latest.photos.map((photo) => [photo.digest, photo]),
        );
        if (
          latest.photos.length +
            originals.filter((p) => !existingByDigest.has(p.digest)).length >
          MAX_TECHNICIAN_PHOTO_COUNT
        )
          throw new ConflictException("目标技师照片数量已达上限");
        const copiedPhotos = [];
        for (const original of originals) {
          let photo = existingByDigest.get(original.digest);
          if (!photo) {
            photo = await tx.technicianPhoto.create({
              data: {
                id: randomUUID(),
                profileId: latest.id,
                digest: original.digest,
                content: original.content,
                width: original.width,
                height: original.height,
              },
            });
            existingByDigest.set(photo.digest, photo);
          }
          copiedPhotos.push({
            sourcePhotoId: original.id,
            targetPhotoId: photo.id,
          });
        }
        const urls = copiedPhotos.map((photo) =>
          this.photos.publicUrl(latest.technicianId, photo.targetPhotoId),
        );
        const avatarUrl = latest.avatarUrl || urls[0]!;
        const galleryUrls = [
          ...new Set([...strings(latest.galleryUrls), ...urls]),
        ].filter((url) => url !== avatarUrl);
        if (galleryUrls.length > 12)
          throw new ConflictException("目标相册已满，请先整理照片");
        await tx.technicianProfile.update({
          where: { id: latest.id },
          data: {
            avatarUrl,
            galleryUrls,
            status: "DRAFT",
            version: { increment: 1 },
            reviewedAt: null,
            reviewedById: null,
            rejectionReason: null,
          },
        });
        await tx.technicianProfile.update({
          where: { id: source.id },
          data: { version: { increment: 1 } },
        });
        await tx.technicianPhotoDraftBinding.create({
          data: {
            sourceProfileId: source.id,
            targetProfileId: latest.id,
            createdById: principal.userId,
            copiedPhotos,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId,
            action: "TECHNICIAN_PHOTO_DRAFT_BOUND",
            resourceType: "TechnicianProfile",
            resourceId: latest.id,
            metadata: {
              sourceProfileId: source.id,
              copiedPhotoCount: copiedPhotos.length,
              personalInformationOverwritten: false,
              membershipGranted: false,
            },
          },
        });
        return {
          sourceTechnicianId: technicianId,
          targetTechnicianId: input.targetTechnicianId,
          idempotentReplay: false,
        };
      },
      { timeout: 20000 },
    );
  }
}

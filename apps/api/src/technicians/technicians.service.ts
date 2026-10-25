import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import {
  MembershipStatus,
  IdentityProvider,
  OrderStatus,
  Prisma,
  TechnicianProfileStatus,
  TechnicianReviewStatus,
  TechnicianIdentityDocumentKind,
  UserRole,
} from "@prisma/client";
import type {
  AdminTechnicianReview,
  AdminTechnicianApplicationUpdate,
  TechnicianApplication,
  TechnicianH5OnboardingStatus,
  TechnicianH5PhotoUpload,
  TechnicianH5ProfileUpdate,
  TechnicianPhoneProfileDraft,
  TechnicianIdentityDocumentUpload,
  TechnicianProfile,
  TechnicianProfileUpdate,
  TechnicianPhotoUpload,
  TechnicianPhotoUploadResult,
  TechnicianReview,
  TechnicianReviewCreate,
  TechnicianOnboarding,
} from "@zydj/contracts";
import { TechnicianH5ProfileUpdateSchema } from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  MAX_TECHNICIAN_PHOTO_COUNT,
  TechnicianPhotoService,
} from "./technician-photo.service.js";

type ProfileRecord = {
  id: string;
  organizationId: string;
  technicianId: string;
  publicName: string;
  ageRange?: string | null;
  version?: number;
  selfRegistered?: boolean;
  registrationChannel?: string;
  realNameEncrypted?: string | null;
  serviceCity?: string;
  serviceAreas?: Prisma.JsonValue;
  availableTimeSlots?: Prisma.JsonValue;
  serviceIds?: Prisma.JsonValue;
  avatarUrl: string | null;
  showcasePhotoId?: string | null;
  galleryUrls: Prisma.JsonValue;
  introduction: string;
  specialties: Prisma.JsonValue;
  serviceYears: number | null;
  certificates: Prisma.JsonValue;
  status: TechnicianProfileStatus;
  rejectionReason: string | null;
  updatedAt: Date;
  technician: { displayName: string };
};

@Injectable()
export class TechniciansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly photos?: TechnicianPhotoService,
    private readonly crypto?: AuthCryptoService,
    private readonly config?: ConfigService<AppEnv, true>,
  ) {}

  private assertWechatRegistration(
    principal: AuthPrincipal,
    requirePhone = true,
  ) {
    if (
      !["WECHAT_MINIAPP", "WECHAT_H5"].includes(principal.authChannel ?? "") ||
      principal.authProvider !== "wechat"
    ) {
      throw new ForbiddenException("请使用本人微信授权登录");
    }
    if (requirePhone && !principal.phoneVerified) {
      throw new ForbiddenException("请先完成本人手机号验证");
    }
  }

  async onboarding(principal: AuthPrincipal): Promise<TechnicianOnboarding> {
    this.assertWechatRegistration(principal, false);
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { technicianId: principal.userId },
      include: { technician: { select: { displayName: true } } },
    });
    const approved =
      profile &&
      (profile.status === "APPROVED" || profile.status === "PUBLISHED");
    return {
      profile: profile ? await this.toProfile(profile, false) : null,
      phoneVerified: principal.phoneVerified === true,
      canEnterWorkbench: Boolean(
        principal.phoneVerified &&
          approved &&
          (await this.hasActiveMembership(profile)),
      ),
    };
  }

  async register(principal: AuthPrincipal): Promise<TechnicianOnboarding> {
    this.assertWechatRegistration(principal);
    await this.registerApplication(principal);
    return this.onboarding(principal);
  }

  async phoneOnboardingStatus(principal: AuthPrincipal) {
    this.assertPhoneApplicant(principal);
    return this.applicationStatus(principal);
  }
  async registerPhone(principal: AuthPrincipal) {
    this.assertPhoneApplicant(principal);
    await this.registerApplication(principal);
    return this.applicationStatus(principal);
  }
  async updatePhoneApplication(
    principal: AuthPrincipal,
    input: TechnicianPhoneProfileDraft,
  ) {
    this.assertPhoneApplicant(principal);
    const current = await this.getH5ApplicationRecord(principal);
    this.assertH5Editable(current);
    const existing = this.toH5Application(current, []);
    return this.updateApplicationProfile(
      principal,
      {
        realName: input.realName ?? existing.realName ?? "",
        serviceCity:
          input.serviceCity ??
          (existing.serviceCity ||
            this.config?.get("SERVICE_CITY", { infer: true }) ||
            ""),
        serviceAreas: input.serviceAreas ?? existing.serviceAreas,
        availableTimeSlots:
          input.availableTimeSlots ?? existing.availableTimeSlots,
        bio: input.bio ?? existing.bio,
        serviceIds: input.serviceIds ?? existing.serviceIds,
      },
      current.version ?? 0,
    );
  }
  async uploadPhoneApplicationPhoto(
    principal: AuthPrincipal,
    input: TechnicianH5PhotoUpload,
  ) {
    this.assertPhoneApplicant(principal);
    return this.uploadApplicationPhoto(principal, input);
  }
  async uploadPhoneIdentityDocument(
    principal: AuthPrincipal,
    input: TechnicianIdentityDocumentUpload,
  ) {
    this.assertPhoneApplicant(principal);
    return this.uploadApplicationIdentityDocument(principal, input);
  }
  async submitPhoneApplication(principal: AuthPrincipal) {
    this.assertPhoneApplicant(principal);
    return this.submitApplication(principal);
  }

  private assertPhoneApplicant(principal: AuthPrincipal) {
    if (
      this.config?.get("TECHNICIAN_PHONE_LOGIN_ENABLED", { infer: true }) !==
        "true" ||
      principal.authChannel !== "TECHNICIAN_PHONE" ||
      principal.authProvider !== "technician-sms" ||
      !principal.phoneVerified
    )
      throw new ForbiddenException("请使用本人手机号验证码登录技师入驻");
  }
  // Only explicit phone wrappers and shared owner helpers use this assertion.
  // Native/H5 controllers retain their stricter channel-specific assertions.
  private assertApplicationRegistration(
    principal: AuthPrincipal,
    requirePhone = true,
  ) {
    if (
      principal.authChannel === "TECHNICIAN_PHONE" ||
      principal.authProvider === "technician-sms"
    )
      this.assertPhoneApplicant(principal);
    else this.assertWechatRegistration(principal, requirePhone);
  }

  private async registerApplication(principal: AuthPrincipal): Promise<void> {
    this.assertApplicationRegistration(principal);
    const phoneApplicant = principal.authChannel === "TECHNICIAN_PHONE";
    const identityProvider =
      principal.authChannel === "WECHAT_H5"
        ? IdentityProvider.WECHAT_H5
        : IdentityProvider.WECHAT_MINIAPP;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR NO KEY UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: principal.userId },
        select: {
          status: true,
          phoneEncrypted: true,
          phoneVerifiedAt: true,
          customerPhoneIdentity: { select: { phoneHash: true } },
          identities: {
            where: { provider: identityProvider },
            select: { id: true, unionIdHash: true },
          },
        },
      });
      if (
        !user ||
        user.status !== "ACTIVE" ||
        !user.phoneEncrypted ||
        !user.phoneVerifiedAt ||
        (phoneApplicant
          ? !this.validPhoneBinding(user)
          : !user.identities.length) ||
        (!phoneApplicant &&
          identityProvider === IdentityProvider.WECHAT_H5 &&
          !user.identities[0]?.unionIdHash)
      ) {
        throw new ForbiddenException("请完成本人微信和手机号验证后再入驻");
      }
      const existing = await tx.technicianProfile.findUnique({
        where: { technicianId: principal.userId },
      });
      if (existing) {
        if (phoneApplicant && !existing.selfRegistered)
          throw new ConflictException(
            "已有平台登记资料，请联系管理后台核验后继续，原资料不会覆盖",
          );
        return;
      }
      // The applicant cannot select a tenant or grant themselves membership.
      const organizations = await tx.organization.findMany({
        where: { services: { some: { published: true } } },
        select: { id: true },
        take: 2,
      });
      if (organizations.length !== 1)
        throw new ServiceUnavailableException(
          "入驻服务组织尚未明确，请联系平台配置",
        );
      const organizationId = organizations[0]!.id;
      const membership = await tx.staffMembership.findFirst({
        where: { userId: principal.userId, role: UserRole.THERAPIST },
      });
      if (
        membership &&
        (membership.status !== MembershipStatus.ACTIVE ||
          membership.organizationId !== organizationId)
      ) {
        throw new ForbiddenException("账号状态或组织归属需由后台核验");
      }
      const created = await tx.technicianProfile.create({
        data: {
          organizationId,
          technicianId: principal.userId,
          publicName: "",
          selfRegistered: true,
          registrationChannel: principal.authChannel ?? "LEGACY",
          status: TechnicianProfileStatus.DRAFT,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_SELF_REGISTRATION_CREATED",
          resourceType: "TechnicianProfile",
          resourceId: created.id,
          metadata: { phoneVerified: true, membershipGranted: false },
        },
      });
    });
  }

  private validPhoneBinding(user: {
    phoneEncrypted: string | null;
    phoneVerifiedAt: Date | null;
    customerPhoneIdentity: { phoneHash: string } | null;
  }) {
    if (
      !this.crypto ||
      !user.phoneEncrypted ||
      !user.phoneVerifiedAt ||
      !user.customerPhoneIdentity
    )
      return false;
    try {
      return (
        user.customerPhoneIdentity.phoneHash ===
        this.crypto.hashPhoneVerification(
          "phone",
          this.crypto.decrypt(user.phoneEncrypted),
        )
      );
    } catch {
      return false;
    }
  }

  async registerH5(
    principal: AuthPrincipal,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, true);
    await this.register(principal);
    return this.h5OnboardingStatus(principal);
  }

  async h5OnboardingStatus(
    principal: AuthPrincipal,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, false);
    return this.applicationStatus(principal);
  }

  async miniappApplicationStatus(principal: AuthPrincipal) {
    this.assertMiniappApplicant(principal, false);
    return this.applicationStatus(principal);
  }

  private async applicationStatus(
    principal: AuthPrincipal,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertApplicationRegistration(principal, false);
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    const [user, profile] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: principal.userId },
        select: { phoneEncrypted: true, phoneVerifiedAt: true },
      }),
      this.prisma.technicianProfile.findFirst({
        where: {
          technicianId: principal.userId,
          selfRegistered: true,
          technician: { status: "ACTIVE" },
        },
        include: { technician: { select: { displayName: true } } },
      }),
    ]);
    const phoneMasked =
      user?.phoneEncrypted && user.phoneVerifiedAt
        ? maskPhone(this.crypto.decrypt(user.phoneEncrypted))
        : null;
    if (!user?.phoneVerifiedAt || !user.phoneEncrypted) {
      return { stage: "PHONE_REQUIRED", phoneMasked, application: null };
    }
    if (!profile) {
      return { stage: "PROFILE_REQUIRED", phoneMasked, application: null };
    }
    const documents = await this.prisma.technicianIdentityDocument.findMany({
      where: { profileId: profile.id },
      select: { kind: true },
    });
    const stage =
      profile.status === TechnicianProfileStatus.PENDING_REVIEW
        ? "PENDING_REVIEW"
        : profile.status === TechnicianProfileStatus.REJECTED
          ? "REJECTED"
          : profile.status === TechnicianProfileStatus.APPROVED ||
              profile.status === TechnicianProfileStatus.PUBLISHED
            ? "APPROVED"
            : "PROFILE_REQUIRED";
    return {
      stage,
      phoneMasked,
      application: this.toH5Application(profile, documents),
    };
  }

  async updateH5Profile(
    principal: AuthPrincipal,
    input: TechnicianH5ProfileUpdate,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, true);
    return this.updateApplicationProfile(principal, input);
  }

  async updateMiniappApplication(
    principal: AuthPrincipal,
    input: TechnicianH5ProfileUpdate,
  ) {
    this.assertMiniappApplicant(principal, true);
    return this.updateApplicationProfile(principal, input);
  }

  private async updateApplicationProfile(
    principal: AuthPrincipal,
    input: TechnicianH5ProfileUpdate,
    expectedVersion?: number,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertApplicationRegistration(principal);
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    const current = await this.getH5ApplicationRecord(principal);
    if (
      expectedVersion !== undefined &&
      expectedVersion !== (current.version ?? 0)
    )
      throw new ConflictException("入驻资料已变化，请重新读取后再保存");
    this.assertH5Editable(current);
    const expectedCity = this.config?.get("SERVICE_CITY", { infer: true });
    if (expectedCity && input.serviceCity !== expectedCity) {
      throw new BadRequestException(`当前仅支持${expectedCity}技师入驻`);
    }
    const services = await this.prisma.service.findMany({
      where: {
        id: { in: input.serviceIds },
        organizationId: current.organizationId,
        published: true,
      },
      select: { id: true, name: true },
    });
    if (services.length !== input.serviceIds.length) {
      throw new BadRequestException("擅长项目包含已下架或不属于当前组织的服务");
    }
    const nameById = new Map(
      services.map((service) => [service.id, service.name]),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "id" = ${current.id} FOR UPDATE`;
      const locked = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        select: {
          id: true,
          technicianId: true,
          selfRegistered: true,
          status: true,
          version: true,
        },
      });
      this.assertH5LockedEditable(current, locked);
      const changed = await tx.technicianProfile.updateMany({
        where: {
          id: current.id,
          technicianId: principal.userId,
          selfRegistered: true,
          status: locked.status,
          version: locked.version,
        },
        data: {
          realNameEncrypted: input.realName
            ? this.crypto!.encryptScoped(
                this.realNamePurpose(current.id),
                input.realName,
              )
            : null,
          serviceCity: input.serviceCity,
          serviceAreas: input.serviceAreas,
          availableTimeSlots: input.availableTimeSlots,
          serviceIds: input.serviceIds,
          introduction: input.bio,
          specialties: input.serviceIds.map((id) => nameById.get(id)!),
          status: TechnicianProfileStatus.DRAFT,
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException("入驻资料状态已变化，请刷新后重试");
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action:
            principal.authChannel === "WECHAT_H5"
              ? "TECHNICIAN_H5_PROFILE_UPDATED"
              : "TECHNICIAN_MINIAPP_APPLICATION_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: {
            changedFields: [
              "realName",
              "serviceCity",
              "serviceAreas",
              "availableTimeSlots",
              "bio",
              "serviceIds",
            ],
          },
        },
      });
    });
    return this.applicationStatus(principal);
  }

  async uploadH5Photo(
    principal: AuthPrincipal,
    input: TechnicianH5PhotoUpload,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, true);
    return this.uploadApplicationPhoto(principal, input);
  }

  async uploadMiniappApplicationPhoto(
    principal: AuthPrincipal,
    input: TechnicianH5PhotoUpload,
  ) {
    this.assertMiniappApplicant(principal, true);
    return this.uploadApplicationPhoto(principal, input);
  }

  private async uploadApplicationPhoto(
    principal: AuthPrincipal,
    input: TechnicianH5PhotoUpload,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertApplicationRegistration(principal);
    const current = await this.getH5ApplicationRecord(principal);
    this.assertH5Editable(current);
    await this.savePhoto(
      principal,
      current,
      { kind: input.kind, base64: input.contentBase64, authorized: true },
      false,
      true,
    );
    return this.applicationStatus(principal);
  }

  async uploadH5IdentityDocument(
    principal: AuthPrincipal,
    input: TechnicianIdentityDocumentUpload,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, true);
    return this.uploadApplicationIdentityDocument(principal, input);
  }

  async uploadMiniappIdentityDocument(
    principal: AuthPrincipal,
    input: TechnicianIdentityDocumentUpload,
  ) {
    this.assertMiniappApplicant(principal, true);
    return this.uploadApplicationIdentityDocument(principal, input);
  }

  private async uploadApplicationIdentityDocument(
    principal: AuthPrincipal,
    input: TechnicianIdentityDocumentUpload,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertApplicationRegistration(principal);
    if (!this.photos || !this.crypto)
      throw new InternalServerErrorException("证件处理服务未就绪");
    const current = await this.getH5ApplicationRecord(principal);
    this.assertH5Editable(current);
    // The same bounded JPEG/PNG decoder used by public photos strips EXIF/GPS,
    // rejects SVG/animated/forged inputs and keeps the decoded payload <=512KB.
    const normalized = await this.photos.normalize(input.contentBase64);
    const kind = input.kind as TechnicianIdentityDocumentKind;
    const encrypted = this.crypto.encryptScoped(
      this.documentPurpose(current.id, kind),
      Buffer.from(normalized.content).toString("base64"),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "id" = ${current.id} FOR UPDATE`;
      const locked = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        select: {
          id: true,
          technicianId: true,
          selfRegistered: true,
          status: true,
          version: true,
        },
      });
      this.assertH5LockedEditable(current, locked);
      const document = await tx.technicianIdentityDocument.upsert({
        where: { profileId_kind: { profileId: current.id, kind } },
        create: {
          profileId: current.id,
          kind,
          contentEncrypted: encrypted,
          digest: normalized.digest,
          width: normalized.width,
          height: normalized.height,
        },
        update: {
          contentEncrypted: encrypted,
          digest: normalized.digest,
          width: normalized.width,
          height: normalized.height,
        },
      });
      const changed = await tx.technicianProfile.updateMany({
        where: {
          id: current.id,
          technicianId: principal.userId,
          selfRegistered: true,
          status: locked.status,
          version: locked.version,
        },
        data: {
          status: TechnicianProfileStatus.DRAFT,
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException("入驻资料状态已变化，请刷新后重试");
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "TECHNICIAN_IDENTITY_DOCUMENT_UPLOADED",
          resourceType: "TechnicianIdentityDocument",
          resourceId: document.id,
          metadata: {
            kind,
            width: normalized.width,
            height: normalized.height,
          },
        },
      });
    });
    return this.applicationStatus(principal);
  }

  async submitH5Application(
    principal: AuthPrincipal,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertH5Principal(principal, true);
    return this.submitApplication(principal);
  }

  async submitMiniappApplication(principal: AuthPrincipal) {
    this.assertMiniappApplicant(principal, true);
    return this.submitApplication(principal);
  }

  private async submitApplication(
    principal: AuthPrincipal,
  ): Promise<TechnicianH5OnboardingStatus> {
    this.assertApplicationRegistration(principal);
    const current = await this.getH5ApplicationRecord(principal);
    if (current.status === TechnicianProfileStatus.PENDING_REVIEW) {
      return this.applicationStatus(principal);
    }
    this.assertH5Editable(current);
    await this.assertApplicationComplete(current);
    await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PENDING_REVIEW,
      principal.authChannel === "WECHAT_H5"
        ? "TECHNICIAN_H5_APPLICATION_SUBMITTED"
        : "TECHNICIAN_MINIAPP_APPLICATION_SUBMITTED",
    );
    return this.applicationStatus(principal);
  }

  async getAdminIdentityDocument(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    kind: TechnicianIdentityDocumentKind,
  ) {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    const profile = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.technicianIdentityDocument.findUnique({
        where: { profileId_kind: { profileId: profile.id, kind } },
      });
      if (!document) throw new NotFoundException("证件照片不存在");
      let content: Uint8Array;
      try {
        content = new Uint8Array(
          Buffer.from(
            this.crypto!.decryptScoped(
              this.documentPurpose(profile.id, kind),
              document.contentEncrypted,
            ),
            "base64",
          ),
        );
      } catch {
        throw new InternalServerErrorException("证件照片无法安全解密");
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_IDENTITY_DOCUMENT_VIEWED",
          resourceType: "TechnicianIdentityDocument",
          resourceId: document.id,
          metadata: { technicianId, kind },
        },
      });
      return { content, mimeType: "image/jpeg" as const };
    });
  }

  async listApplications(
    principal: AuthPrincipal,
    organizationId: string,
  ): Promise<TechnicianApplication[]> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const rows = await this.prisma.technicianProfile.findMany({
      where: {
        organizationId,
        OR: [
          { selfRegistered: true },
          { registrationChannel: "ADMIN_PHOTO_DRAFT" },
        ],
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return Promise.all(rows.map((row) => this.toApplication(row)));
  }

  async listPublic(): Promise<TechnicianProfile[]> {
    const profiles = await this.prisma.technicianProfile.findMany({
      where: {
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
      orderBy: [{ updatedAt: "desc" }, { publicName: "asc" }],
      take: 100,
    });
    if (!profiles.length) return [];

    const activeMemberships = await this.prisma.staffMembership.findMany({
      where: {
        userId: { in: profiles.map((profile) => profile.technicianId) },
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      select: { userId: true, organizationId: true },
    });
    const allowed = new Set(
      activeMemberships.map(
        ({ userId, organizationId }) => `${userId}:${organizationId}`,
      ),
    );
    return Promise.all(
      profiles
        .filter((profile) =>
          allowed.has(`${profile.technicianId}:${profile.organizationId}`),
        )
        .map((profile) => this.toProfile(profile, true)),
    );
  }

  async getPublic(technicianId: string): Promise<TechnicianProfile> {
    const profile = await this.prisma.technicianProfile.findFirst({
      where: {
        technicianId,
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
    });
    if (!profile || !(await this.hasActiveMembership(profile))) {
      throw new NotFoundException("技师资料不存在或尚未发布");
    }
    return this.toProfile(profile, true);
  }

  async listPublicReviews(technicianId: string): Promise<TechnicianReview[]> {
    const profile = await this.getPublicProfileRecord(technicianId);
    const rows = await this.prisma.technicianReview.findMany({
      where: {
        organizationId: profile.organizationId,
        technicianId,
        status: TechnicianReviewStatus.PUBLISHED,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return rows.map((row) => this.toReview(row));
  }

  async getOwnProfile(principal: AuthPrincipal): Promise<TechnicianProfile> {
    const membership = await this.getOwnMembership(principal);
    const profile = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    return this.toProfile(profile, false);
  }

  async updateOwnProfile(
    principal: AuthPrincipal,
    input: TechnicianProfileUpdate,
  ): Promise<TechnicianProfile> {
    const membership = await this.getOwnActiveMembership(principal);
    const current = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    const data = this.profileUpdateData(input);
    data.version = { increment: 1 };
    data.status = TechnicianProfileStatus.DRAFT;
    data.rejectionReason = null;
    data.reviewedById = null;
    data.reviewedAt = null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.technicianProfile.update({
        where: { technicianId: principal.userId },
        data,
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "TECHNICIAN_PROFILE_SELF_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: { changedFields: Object.keys(input).sort() },
        },
      });
      return record;
    });
    return this.toProfile(updated, false);
  }

  async submitOwnProfile(principal: AuthPrincipal): Promise<TechnicianProfile> {
    const membership = await this.getOwnActiveMembership(principal);
    const current = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    if (current.status === TechnicianProfileStatus.PENDING_REVIEW) {
      return this.toProfile(current, false);
    }
    if (
      current.status !== TechnicianProfileStatus.DRAFT &&
      current.status !== TechnicianProfileStatus.REJECTED
    ) {
      throw new ConflictException("当前资料状态不能重复提交审核");
    }
    this.assertProfileComplete(current);
    await this.assertSelfRegisteredApplicationComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PENDING_REVIEW,
      "TECHNICIAN_PROFILE_SUBMITTED",
    );
    return this.toProfile(updated, false);
  }

  async uploadOwnPhoto(
    principal: AuthPrincipal,
    input: TechnicianPhotoUpload,
  ): Promise<TechnicianPhotoUploadResult> {
    const membership = await this.getOwnActiveMembership(principal);
    const current = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    return this.savePhoto(principal, current, input, false);
  }

  async uploadAdminPhoto(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: TechnicianPhotoUpload,
  ): Promise<TechnicianPhotoUploadResult> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    return this.savePhoto(principal, current, input, true);
  }

  async getPublicPhoto(technicianId: string, photoId: string) {
    const profile = await this.getPublicProfileRecord(technicianId);
    const photo = await this.prisma.technicianPhoto.findFirst({
      where: { id: photoId, profileId: profile.id },
    });
    const urls = [
      profile.avatarUrl,
      ...this.stringArray(profile.galleryUrls, "相册"),
    ];
    const expectedPath = `/v1/technicians/${encodeURIComponent(technicianId)}/photos/${encodeURIComponent(photoId)}`;
    if (
      !photo ||
      !urls.some((url) => url && new URL(url).pathname === expectedPath)
    ) {
      throw new NotFoundException("照片未公开或已从资料中移除");
    }
    return photo;
  }

  async getOwnPhoto(principal: AuthPrincipal, photoId: string) {
    const membership = await this.getOwnMembership(principal);
    return this.getPrivatePhoto(
      membership.organizationId,
      principal.userId,
      photoId,
    );
  }

  async getAdminPhoto(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    photoId: string,
  ) {
    await this.getAuthorizedProfile(principal, organizationId, technicianId);
    return this.getPrivatePhoto(organizationId, technicianId, photoId);
  }

  private async getPrivatePhoto(
    organizationId: string,
    technicianId: string,
    photoId: string,
  ) {
    const photo = await this.prisma.technicianPhoto.findFirst({
      where: { id: photoId, profile: { organizationId, technicianId } },
    });
    if (!photo) throw new NotFoundException("本人照片不存在");
    return photo;
  }

  private async savePhoto(
    principal: AuthPrincipal,
    current: ProfileRecord,
    input: TechnicianPhotoUpload,
    adminView: boolean,
    enforceH5Editable = false,
  ): Promise<TechnicianPhotoUploadResult> {
    if (!this.photos) throw new InternalServerErrorException("照片服务未就绪");
    const candidateId = randomUUID();
    // Validate configuration before accepting or processing any photo bytes.
    this.photos.publicUrl(current.technicianId, candidateId);
    const normalized = await this.photos.normalize(input.base64);
    const photos = this.photos;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TechnicianProfile" WHERE "id" = ${current.id} FOR UPDATE`;
      const locked = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
      });
      if (enforceH5Editable) this.assertH5LockedEditable(current, locked);
      let photo = await tx.technicianPhoto.findUnique({
        where: {
          profileId_digest: {
            profileId: current.id,
            digest: normalized.digest,
          },
        },
      });
      if (!photo) {
        const [count, recentCount] = await Promise.all([
          tx.technicianPhoto.count({ where: { profileId: current.id } }),
          tx.technicianPhoto.count({
            where: {
              profileId: current.id,
              createdAt: { gte: new Date(Date.now() - 60_000) },
            },
          }),
        ]);
        if (count >= MAX_TECHNICIAN_PHOTO_COUNT)
          throw new ForbiddenException(
            "照片存储已达24张上限，请联系管理员整理历史照片",
          );
        if (recentCount >= 6)
          throw new ForbiddenException("照片上传过于频繁，请一分钟后重试");
        photo = await tx.technicianPhoto.create({
          data: { id: candidateId, profileId: current.id, ...normalized },
        });
      }
      const publicUrl = photos.publicUrl(current.technicianId, photo.id);
      const gallery = this.stringArray(locked.galleryUrls, "相册");
      if (
        input.kind === "GALLERY" &&
        !gallery.includes(publicUrl) &&
        gallery.length >= 12
      ) {
        throw new ForbiddenException(
          "公开相册最多12张，请先移除不再展示的照片",
        );
      }
      // All new photos invalidate any previous review, including admin uploads.
      const status = TechnicianProfileStatus.DRAFT;
      const record = await tx.technicianProfile.update({
        where: { id: current.id },
        data: {
          ...(input.kind === "AVATAR"
            ? { avatarUrl: publicUrl }
            : { galleryUrls: [...new Set([...gallery, publicUrl])] }),
          status,
          rejectionReason: null,
          version: { increment: 1 },
          reviewedById: null,
          reviewedAt: null,
        },
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: adminView
            ? "TECHNICIAN_PHOTO_ADMIN_UPLOADED"
            : "TECHNICIAN_PHOTO_SELF_UPLOADED",
          resourceType: "TechnicianPhoto",
          resourceId: photo.id,
          metadata: {
            kind: input.kind,
            previousStatus: locked.status,
            status,
            width: photo.width,
            height: photo.height,
          },
        },
      });
      return { photoId: photo.id, publicUrl, record };
    });
    return {
      photoId: result.photoId,
      publicUrl: result.publicUrl,
      profile: await this.toProfile(result.record, false),
    };
  }

  async getAdminProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const profile = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    return this.toProfile(profile, false);
  }

  async updateAdminApplication(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: AdminTechnicianApplicationUpdate,
  ): Promise<TechnicianApplication> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    if (current.version !== input.expectedVersion)
      throw new ConflictException("入驻资料已变化，请刷新后重新补录");
    const draft = input.profile;
    const city = this.config?.get("SERVICE_CITY", { infer: true });
    if (draft.serviceCity !== undefined && city && draft.serviceCity !== city)
      throw new BadRequestException(`当前仅支持${city}技师入驻`);
    const services =
      draft.serviceIds === undefined
        ? undefined
        : await this.prisma.service.findMany({
            where: {
              id: { in: draft.serviceIds },
              organizationId,
              published: true,
            },
            select: { id: true, name: true },
          });
    if (services && services.length !== draft.serviceIds!.length)
      throw new BadRequestException("擅长项目包含已下架或不属于当前组织的服务");
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.technicianProfile.updateMany({
        where: {
          id: current.id,
          organizationId,
          technicianId,
          version: input.expectedVersion,
        },
        data: {
          ...(draft.realName !== undefined
            ? {
                realNameEncrypted: draft.realName
                  ? this.crypto!.encryptScoped(
                      this.realNamePurpose(current.id),
                      draft.realName,
                    )
                  : null,
              }
            : {}),
          ...(draft.serviceCity !== undefined
            ? { serviceCity: draft.serviceCity }
            : {}),
          ...(draft.serviceAreas !== undefined
            ? { serviceAreas: draft.serviceAreas }
            : {}),
          ...(draft.availableTimeSlots !== undefined
            ? { availableTimeSlots: draft.availableTimeSlots }
            : {}),
          ...(draft.bio !== undefined ? { introduction: draft.bio } : {}),
          ...(services
            ? {
                serviceIds: draft.serviceIds,
                specialties: draft.serviceIds!.map(
                  (id) => services.find((s) => s.id === id)!.name,
                ),
              }
            : {}),
          status: TechnicianProfileStatus.DRAFT,
          version: { increment: 1 },
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
        },
      });
      if (changed.count !== 1)
        throw new ConflictException("入驻资料已变化，请刷新后重新补录");
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_APPLICATION_ADMIN_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: {
            changedFields: Object.keys(draft).sort(),
            previousVersion: input.expectedVersion,
            previousStatus: current.status,
          },
        },
      });
      return tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        include: { technician: { select: { displayName: true } } },
      });
    });
    return this.toApplication(updated);
  }

  async updateAdminProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: TechnicianProfileUpdate,
  ): Promise<TechnicianProfile> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      const data = this.profileUpdateData(input);
      data.version = { increment: 1 };
      data.status = TechnicianProfileStatus.DRAFT;
      data.rejectionReason = null;
      data.reviewedById = null;
      data.reviewedAt = null;
      const changed = await tx.technicianProfile.updateMany({
        where: {
          id: current.id,
          status: current.status,
          version: current.version ?? 0,
        },
        data,
      });
      if (changed.count !== 1) {
        throw new ConflictException(
          "技师资料内容或审核状态已变化，请刷新后重新操作",
        );
      }
      const record = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_PROFILE_ADMIN_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: {
            changedFields: Object.keys(input).sort(),
            previousStatus: current.status,
            status: record.status,
          },
        },
      });
      return record;
    });
    return this.toProfile(updated, false);
  }

  async submitAdminProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.PENDING_REVIEW)
      return this.toProfile(current, false);
    if (
      current.status !== TechnicianProfileStatus.DRAFT &&
      current.status !== TechnicianProfileStatus.REJECTED
    ) {
      throw new ConflictException("当前资料状态不能重复提交审核");
    }
    this.assertProfileComplete(current);
    await this.assertSelfRegisteredApplicationComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PENDING_REVIEW,
      "TECHNICIAN_PROFILE_ADMIN_SUBMITTED",
    );
    return this.toProfile(updated, false);
  }

  async approve(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    expectedVersion?: number,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    // A supplied review version must match for legacy/invited profiles too;
    // otherwise the server could approve a newer snapshot than the one shown.
    // Self-registration still requires a version, while older unversioned
    // legacy clients retain their existing compatibility path.
    if (
      (current.selfRegistered || expectedVersion !== undefined) &&
      expectedVersion !== current.version
    )
      throw new ConflictException("入驻资料已更新，请刷新并重新核验后审核");
    if (current.status === TechnicianProfileStatus.APPROVED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.PENDING_REVIEW) {
      throw new ConflictException("仅待审核资料可以批准");
    }
    this.assertProfileComplete(current);
    await this.assertSelfRegisteredApplicationComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.APPROVED,
      "TECHNICIAN_PROFILE_APPROVED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async publish(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.PUBLISHED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.APPROVED) {
      throw new ConflictException("仅已批准资料可以发布");
    }
    this.assertProfileComplete(current);
    await this.assertSelfRegisteredApplicationComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PUBLISHED,
      "TECHNICIAN_PROFILE_PUBLISHED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async reject(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reason: string,
    expectedVersion: number,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (expectedVersion !== current.version)
      throw new ConflictException("资料已更新，请刷新后重新审核");
    if (current.status !== TechnicianProfileStatus.PENDING_REVIEW)
      throw new ConflictException("仅待审核资料可以退回");
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.REJECTED,
      "TECHNICIAN_PROFILE_REJECTED",
      true,
      reason,
    );
    return this.toProfile(updated, false);
  }

  async unpublish(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.APPROVED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.PUBLISHED) {
      throw new ConflictException("当前资料尚未发布");
    }
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.APPROVED,
      "TECHNICIAN_PROFILE_UNPUBLISHED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async createReview(
    principal: AuthPrincipal,
    orderId: string,
    input: TechnicianReviewCreate,
  ): Promise<TechnicianReview> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        therapistId: true,
        status: true,
        technicianReview: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId) {
      throw new ForbiddenException("不能评价其他用户的订单");
    }
    if (order.status !== OrderStatus.COMPLETED) {
      throw new ConflictException("订单完成后才能评价");
    }
    if (!order.therapistId) throw new ConflictException("订单尚未关联技师");
    if (order.technicianReview) throw new ConflictException("该订单已经评价");

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const review = await tx.technicianReview.create({
          data: {
            organizationId: order.organizationId,
            orderId: order.id,
            customerId: principal.userId,
            technicianId: order.therapistId!,
            rating: input.rating,
            content: input.content,
            status: TechnicianReviewStatus.PENDING_REVIEW,
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "CUSTOMER_REVIEW_CREATED",
            actorId: principal.userId,
            payload: { reviewId: review.id, rating: input.rating },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: order.organizationId,
            action: "TECHNICIAN_REVIEW_CREATED",
            resourceType: "TechnicianReview",
            resourceId: review.id,
            metadata: { orderId: order.id, technicianId: order.therapistId },
          },
        });
        await tx.outboxEvent.create({
          data: {
            organizationId: order.organizationId,
            aggregateId: review.id,
            type: "TECHNICIAN_REVIEW_SUBMITTED",
            payload: {
              reviewId: review.id,
              orderId: order.id,
              technicianId: order.therapistId,
            },
          },
        });
        return review;
      });
      return this.toReview(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("该订单已经评价");
      }
      throw error;
    }
  }

  async listAdminReviews(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<AdminTechnicianReview[]> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    await this.getAuthorizedProfile(principal, organizationId, technicianId);
    const rows = await this.prisma.technicianReview.findMany({
      where: { organizationId, technicianId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return rows.map((row) => this.toAdminReview(row));
  }

  async publishReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
  ): Promise<AdminTechnicianReview> {
    return this.moderateReview(
      principal,
      organizationId,
      technicianId,
      reviewId,
      TechnicianReviewStatus.PUBLISHED,
    );
  }

  async hideReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
  ): Promise<AdminTechnicianReview> {
    return this.moderateReview(
      principal,
      organizationId,
      technicianId,
      reviewId,
      TechnicianReviewStatus.HIDDEN,
    );
  }

  private async getPublicProfileRecord(technicianId: string) {
    const profile = await this.prisma.technicianProfile.findFirst({
      where: {
        technicianId,
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
    });
    if (!profile || !(await this.hasActiveMembership(profile))) {
      throw new NotFoundException("技师资料不存在或尚未发布");
    }
    return profile;
  }

  private async moderateReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
    status: Exclude<TechnicianReviewStatus, "PENDING_REVIEW">,
  ): Promise<AdminTechnicianReview> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    await this.getTechnicianMembership(organizationId, technicianId);
    const current = await this.prisma.technicianReview.findUnique({
      where: { id: reviewId },
    });
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.technicianId !== technicianId
    ) {
      throw new NotFoundException("评价不存在");
    }
    if (current.status === status) return this.toAdminReview(current);

    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.technicianReview.updateMany({
        where: {
          id: reviewId,
          organizationId,
          technicianId,
          status: current.status,
        },
        data: { status },
      });
      if (changed.count !== 1)
        throw new ConflictException("评价审核状态已变化");
      const updated = await tx.technicianReview.findUniqueOrThrow({
        where: { id: reviewId },
      });
      const action =
        status === TechnicianReviewStatus.PUBLISHED
          ? "TECHNICIAN_REVIEW_PUBLISHED"
          : "TECHNICIAN_REVIEW_HIDDEN";
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action,
          resourceType: "TechnicianReview",
          resourceId: reviewId,
          metadata: {
            technicianId,
            previousStatus: current.status,
            status,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateId: reviewId,
          type: action,
          payload: { reviewId, technicianId, status },
        },
      });
      return this.toAdminReview(updated);
    });
  }

  private async hasActiveMembership(profile: {
    organizationId: string;
    technicianId: string;
  }) {
    return !!(await this.prisma.staffMembership.findFirst({
      where: {
        organizationId: profile.organizationId,
        userId: profile.technicianId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      select: { id: true },
    }));
  }

  private async getOwnMembership(principal: AuthPrincipal) {
    const membership = await this.findOwnActiveMembership(principal);
    if (!membership) {
      this.assertApplicationRegistration(principal);
      const application = await this.prisma.technicianProfile.findFirst({
        where: {
          technicianId: principal.userId,
          selfRegistered: true,
          technician: { status: "ACTIVE" },
        },
        select: { organizationId: true },
      });
      if (!application) throw new ForbiddenException("请先提交本人入驻申请");
      return application;
    }
    return membership;
  }

  private async getOwnActiveMembership(principal: AuthPrincipal) {
    const membership = await this.findOwnActiveMembership(principal);
    if (!membership) {
      throw new ForbiddenException("仅审核通过且已启用的技师可修改工作台资料");
    }
    return membership;
  }

  private async findOwnActiveMembership(principal: AuthPrincipal) {
    return this.prisma.staffMembership.findFirst({
      where: {
        userId: principal.userId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });
  }

  private async getTechnicianMembership(
    organizationId: string,
    technicianId: string,
  ) {
    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        organizationId,
        userId: technicianId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { user: { select: { displayName: true } } },
    });
    if (!membership) throw new NotFoundException("有效技师账号不存在");
    return membership;
  }

  private async ensureProfile(
    organizationId: string,
    technicianId: string,
    displayName: string,
  ): Promise<ProfileRecord> {
    const profile = await this.prisma.technicianProfile.upsert({
      where: { technicianId },
      create: {
        organizationId,
        technicianId,
        // Do not copy a potentially private account name into public profiles.
        publicName: "",
      },
      update: {},
      include: { technician: { select: { displayName: true } } },
    });
    if (profile.organizationId !== organizationId) {
      throw new ConflictException(
        "技师资料已归属其他组织，请由管理员核验账号归属",
      );
    }
    return profile;
  }

  private async getAuthorizedProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<ProfileRecord> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        organizationId,
        userId: technicianId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { user: { select: { displayName: true } } },
    });
    if (!membership) {
      const application = await this.prisma.technicianProfile.findFirst({
        where: {
          organizationId,
          technicianId,
          OR: [
            { selfRegistered: true },
            { registrationChannel: "ADMIN_PHOTO_DRAFT" },
          ],
          technician: { status: "ACTIVE" },
        },
        include: { technician: { select: { displayName: true } } },
      });
      if (!application) throw new NotFoundException("有效技师或入驻申请不存在");
      return application;
    }
    return this.ensureProfile(
      organizationId,
      technicianId,
      membership.user.displayName,
    );
  }

  private profileUpdateData(
    input: TechnicianProfileUpdate,
  ): Prisma.TechnicianProfileUncheckedUpdateInput {
    const data: Prisma.TechnicianProfileUncheckedUpdateInput = {};
    if (input.publicName !== undefined) data.publicName = input.publicName;
    if (input.ageRange !== undefined) data.ageRange = input.ageRange;
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;
    if (input.galleryUrls !== undefined) data.galleryUrls = input.galleryUrls;
    if (input.introduction !== undefined)
      data.introduction = input.introduction;
    if (input.specialties !== undefined) data.specialties = input.specialties;
    if (input.serviceYears !== undefined)
      data.serviceYears = input.serviceYears;
    if (input.certificates !== undefined)
      data.certificates = input.certificates;
    return data;
  }

  private async changeStatus(
    principal: AuthPrincipal,
    current: ProfileRecord,
    status: TechnicianProfileStatus,
    action: string,
    reviewed = false,
    rejectionReason: string | null = null,
  ): Promise<ProfileRecord> {
    return this.prisma.$transaction(async (tx) => {
      if (
        current.selfRegistered &&
        status === TechnicianProfileStatus.APPROVED
      ) {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${current.technicianId} FOR NO KEY UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: current.technicianId },
          select: {
            status: true,
            phoneEncrypted: true,
            phoneVerifiedAt: true,
            customerPhoneIdentity: { select: { phoneHash: true } },
            identities: {
              where: {
                provider:
                  current.registrationChannel === "WECHAT_H5"
                    ? IdentityProvider.WECHAT_H5
                    : IdentityProvider.WECHAT_MINIAPP,
              },
              select: { id: true, unionIdHash: true },
            },
          },
        });
        if (
          !user ||
          user.status !== "ACTIVE" ||
          !user.phoneEncrypted ||
          !user.phoneVerifiedAt ||
          (current.registrationChannel === "TECHNICIAN_PHONE"
            ? !this.validPhoneBinding(user)
            : !user.identities.length) ||
          (current.registrationChannel === "WECHAT_H5" &&
            !user.identities[0]?.unionIdHash)
        ) {
          throw new ForbiddenException("入驻账号的本人微信或手机号验证已失效");
        }
        const memberships = await tx.staffMembership.findMany({
          where: { userId: current.technicianId, role: UserRole.THERAPIST },
        });
        if (
          memberships.some(
            (row) =>
              row.organizationId !== current.organizationId ||
              row.status !== MembershipStatus.ACTIVE,
          )
        ) {
          throw new ForbiddenException(
            "不可通过资料审核恢复停用账号或更换所属组织",
          );
        }
        if (!memberships.length)
          await tx.staffMembership.create({
            data: {
              userId: current.technicianId,
              organizationId: current.organizationId,
              role: UserRole.THERAPIST,
              status: MembershipStatus.ACTIVE,
            },
          });
      }
      const changed = await tx.technicianProfile.updateMany({
        where: {
          id: current.id,
          status: current.status,
          version: current.version ?? 0,
        },
        data: {
          status,
          version: { increment: 1 },
          rejectionReason,
          reviewedById: reviewed ? principal.userId : null,
          reviewedAt: reviewed ? new Date() : null,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException(
          "技师资料内容或审核状态已变化，请刷新后重新审核",
        );
      }
      const updated = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action,
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: { previousStatus: current.status, status },
        },
      });
      return updated;
    });
  }

  private assertH5Principal(principal: AuthPrincipal, requirePhone: boolean) {
    if (
      principal.authChannel !== "WECHAT_H5" ||
      principal.authProvider !== "wechat"
    ) {
      throw new ForbiddenException("请在微信内通过技师入驻H5链接授权登录");
    }
    if (requirePhone && !principal.phoneVerified) {
      throw new ForbiddenException("请先完成本人手机号短信验证");
    }
  }

  private assertMiniappApplicant(
    principal: AuthPrincipal,
    requirePhone: boolean,
  ) {
    if (principal.authChannel !== "WECHAT_MINIAPP") {
      throw new ForbiddenException("请通过本人微信小程序授权登录");
    }
    this.assertWechatRegistration(principal, requirePhone);
  }

  private async getH5ApplicationRecord(
    principal: AuthPrincipal,
  ): Promise<ProfileRecord> {
    const profile = await this.prisma.technicianProfile.findFirst({
      where: {
        technicianId: principal.userId,
        selfRegistered: true,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
    });
    if (!profile) {
      throw new ForbiddenException("请先完成手机号验证并创建入驻申请");
    }
    return profile;
  }

  private assertH5Editable(profile: ProfileRecord) {
    if (
      profile.status !== TechnicianProfileStatus.DRAFT &&
      profile.status !== TechnicianProfileStatus.REJECTED
    ) {
      throw new ConflictException("当前入驻资料已提交审核，不能继续修改");
    }
  }

  private assertH5LockedEditable(
    expected: ProfileRecord,
    locked: {
      technicianId: string;
      selfRegistered: boolean;
      status: TechnicianProfileStatus;
      version: number;
    },
  ) {
    if (
      locked.technicianId !== expected.technicianId ||
      !locked.selfRegistered
    ) {
      throw new ForbiddenException("入驻资料不属于当前微信账号");
    }
    if (
      locked.status !== expected.status ||
      locked.version !== (expected.version ?? 0)
    ) {
      throw new ConflictException("入驻资料状态已变化，请刷新后重试");
    }
    if (
      locked.status !== TechnicianProfileStatus.DRAFT &&
      locked.status !== TechnicianProfileStatus.REJECTED
    ) {
      throw new ConflictException("当前入驻资料已提交审核，不能继续修改");
    }
  }

  private async assertSelfRegisteredApplicationComplete(
    profile: ProfileRecord,
  ) {
    if (profile.registrationChannel === "ADMIN_PHOTO_DRAFT") {
      throw new ForbiddenException(
        "照片预建档可先补录资料；关联技师本人入驻账号后再提交审核和发布",
      );
    }
    if (
      profile.registrationChannel === "WECHAT_H5" ||
      (profile.selfRegistered &&
        profile.registrationChannel === "TECHNICIAN_PHONE") ||
      (profile.selfRegistered &&
        profile.registrationChannel === "WECHAT_MINIAPP")
    ) {
      await this.assertApplicationComplete(profile);
    }
  }

  private async assertApplicationComplete(profile: ProfileRecord) {
    if (profile.registrationChannel === "TECHNICIAN_PHONE") {
      const privateView = this.toH5Application(profile, []);
      if (
        !TechnicianH5ProfileUpdateSchema.safeParse({
          realName: privateView.realName,
          serviceCity: privateView.serviceCity,
          serviceAreas: privateView.serviceAreas,
          availableTimeSlots: privateView.availableTimeSlots,
          bio: privateView.bio,
          serviceIds: privateView.serviceIds,
        }).success
      )
        throw new ForbiddenException(
          "请填写完整姓名、城市、区域、时段、简介和擅长项目后提交审核",
        );
    }
    const serviceIds = this.stringArray(profile.serviceIds ?? [], "擅长项目");
    const documents = await this.prisma.technicianIdentityDocument.findMany({
      where: { profileId: profile.id },
      select: { kind: true },
    });
    const documentKinds = new Set(documents.map((document) => document.kind));
    if (
      !profile.realNameEncrypted ||
      !profile.serviceCity?.trim() ||
      !this.stringArray(profile.serviceAreas ?? [], "接单区域").length ||
      !this.stringArray(profile.availableTimeSlots ?? [], "可接单时段")
        .length ||
      !serviceIds.length ||
      !profile.avatarUrl ||
      !profile.introduction.trim() ||
      !documentKinds.has(TechnicianIdentityDocumentKind.ID_FRONT) ||
      !documentKinds.has(TechnicianIdentityDocumentKind.ID_BACK)
    ) {
      throw new ForbiddenException(
        "请填写完整入驻资料，并上传形象照及身份证正反面",
      );
    }
    const publishedServices = await this.prisma.service.count({
      where: {
        id: { in: serviceIds },
        organizationId: profile.organizationId,
        published: true,
      },
    });
    if (publishedServices !== serviceIds.length) {
      throw new ConflictException("擅长项目状态已变化，请重新选择");
    }
  }

  private toH5Application(
    profile: ProfileRecord,
    documents: Array<{ kind: TechnicianIdentityDocumentKind }>,
  ) {
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    const documentKinds = new Set(documents.map((document) => document.kind));
    let realName: string | null = null;
    if (profile.realNameEncrypted) {
      try {
        realName = this.crypto.decryptScoped(
          this.realNamePurpose(profile.id),
          profile.realNameEncrypted,
        );
      } catch {
        throw new InternalServerErrorException("真实姓名无法安全解密");
      }
    }
    return {
      id: profile.id,
      status: profile.status,
      realName,
      serviceCity: profile.serviceCity ?? "",
      serviceAreas: this.stringArray(profile.serviceAreas ?? [], "接单区域"),
      availableTimeSlots: this.stringArray(
        profile.availableTimeSlots ?? [],
        "可接单时段",
      ),
      bio: profile.introduction,
      serviceIds: this.stringArray(profile.serviceIds ?? [], "擅长项目"),
      avatarUrl: profile.avatarUrl,
      galleryUrls: this.stringArray(profile.galleryUrls, "相册"),
      hasIdFront: documentKinds.has(TechnicianIdentityDocumentKind.ID_FRONT),
      hasIdBack: documentKinds.has(TechnicianIdentityDocumentKind.ID_BACK),
      rejectionReason: profile.rejectionReason,
      updatedAt: profile.updatedAt.toISOString(),
      version: profile.version ?? 0,
    };
  }

  private async toApplication(
    profile: ProfileRecord,
  ): Promise<TechnicianApplication> {
    if (!this.crypto)
      throw new InternalServerErrorException("身份加密服务未就绪");
    const [base, documents] = await Promise.all([
      this.toProfile(profile, false),
      this.prisma.technicianIdentityDocument.findMany({
        where: { profileId: profile.id },
        select: { kind: true },
      }),
    ]);
    const privateView = this.toH5Application(profile, documents);
    return {
      ...base,
      realName: privateView.realName,
      serviceCity: privateView.serviceCity,
      serviceAreas: privateView.serviceAreas,
      availableTimeSlots: privateView.availableTimeSlots,
      serviceIds: privateView.serviceIds,
      registrationChannel: (profile.registrationChannel ??
        "LEGACY") as TechnicianApplication["registrationChannel"],
      identityDocuments: {
        idFrontUploaded: privateView.hasIdFront,
        idBackUploaded: privateView.hasIdBack,
      },
    };
  }

  private realNamePurpose(profileId: string) {
    return `technician-real-name:${profileId}`;
  }

  private documentPurpose(
    profileId: string,
    kind: TechnicianIdentityDocumentKind,
  ) {
    return `technician-identity-document:${profileId}:${kind}`;
  }

  private assertProfileComplete(profile: ProfileRecord) {
    if (
      !profile.avatarUrl ||
      !profile.introduction.trim() ||
      !this.stringArray(profile.specialties, "擅长项目").length
    ) {
      throw new ForbiddenException(
        "头像、真实简介和擅长项目填写完整后才能提交；公开称呼和年龄段可留空",
      );
    }
  }

  private async toProfile(
    profile: ProfileRecord,
    publicView: boolean,
  ): Promise<TechnicianProfile> {
    const [reviewStats, completedOrders, recentRows] = await Promise.all([
      this.prisma.technicianReview.aggregate({
        where: {
          organizationId: profile.organizationId,
          technicianId: profile.technicianId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.order.count({
        where: {
          organizationId: profile.organizationId,
          therapistId: profile.technicianId,
          status: OrderStatus.COMPLETED,
        },
      }),
      this.prisma.technicianReview.findMany({
        where: {
          organizationId: profile.organizationId,
          technicianId: profile.technicianId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      }),
    ]);
    return {
      technicianId: profile.technicianId,
      displayName: publicView
        ? profile.publicName
        : profile.technician.displayName,
      publicName: profile.publicName,
      ageRange: (profile.ageRange ?? null) as TechnicianProfile["ageRange"],
      avatarUrl: profile.avatarUrl,
      galleryUrls: this.stringArray(profile.galleryUrls, "相册"),
      introduction: profile.introduction,
      specialties: this.stringArray(profile.specialties, "擅长项目"),
      serviceYears: profile.serviceYears,
      certificates: this.stringArray(profile.certificates, "资质证书"),
      reviewSummary: {
        averageRating: reviewStats._avg.rating,
        reviewCount: reviewStats._count._all,
        completedOrders,
      },
      recentReviews: recentRows.map((row) => this.toReview(row)),
      status: profile.status,
      rejectionReason: publicView ? null : profile.rejectionReason,
      freeTravelFee: true,
      travelFeeFen: 0,
      version: publicView ? undefined : (profile.version ?? 0),
      showcasePublished: publicView ? undefined : Boolean(profile.showcasePhotoId),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  private toReview(row: {
    id: string;
    technicianId: string;
    rating: number;
    content: string;
    createdAt: Date;
  }): TechnicianReview {
    return {
      id: row.id,
      technicianId: row.technicianId,
      customerAlias: "已认证客户",
      rating: row.rating,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAdminReview(row: {
    id: string;
    orderId: string;
    technicianId: string;
    rating: number;
    content: string;
    status: TechnicianReviewStatus;
    createdAt: Date;
    updatedAt: Date;
  }): AdminTechnicianReview {
    return {
      ...this.toReview(row),
      orderId: row.orderId,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private stringArray(value: Prisma.JsonValue, field: string): string[] {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      throw new InternalServerErrorException(`${field}资料格式异常`);
    }
    return value;
  }
}

const maskPhone = (phone: string) =>
  /^1\d{10}$/.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : "***";

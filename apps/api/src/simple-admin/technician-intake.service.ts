import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  TechnicianIntakeSubmissionSchema,
  type TechnicianIntakeSubmission,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { TechnicianPhotoService } from "../technicians/technician-photo.service.js";

type Tx = Prisma.TransactionClient;
const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_VERSION = "technician-intake-2026-10-31";

@Injectable()
export class TechnicianIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly photos: TechnicianPhotoService,
    private readonly access: AccessControlService,
  ) {}

  async submit(
    input: TechnicianIntakeSubmission,
    key: string | undefined,
    ip: string,
  ) {
    const parsed = TechnicianIntakeSubmissionSchema.safeParse(input);
    if (
      !parsed.success ||
      !key ||
      !KEY.test(key) ||
      !ip ||
      ip.length > 128 ||
      /[\x00-\x1f]/.test(ip)
    )
      throw new BadRequestException(
        "请填写姓名、正确手机号，上传一张证书照片并同意资料使用说明",
      );
    const data = parsed.data;
    const now = new Date();
    const keyHash = this.crypto.hashPhoneVerification(
      "technician-intake-key",
      key.toLowerCase(),
    );
    const requestHash = this.crypto.hashPhoneVerification(
      "technician-intake-request",
      JSON.stringify(data),
    );
    const receipt = (row: { id: string; requestHash: string }) => {
      if (row.requestHash !== requestHash)
        throw new ConflictException("本次提交内容已变化，请重新提交");
      // This is the original submission acknowledgement, not a public status API.
      return { receiptId: row.id, status: "PENDING_REVIEW" as const };
    };
    const existing = await this.prisma.technicianIntakeApplication.findUnique({
      where: { submissionKeyHash: keyHash },
      select: { id: true, requestHash: true },
    });
    if (existing) return receipt(existing);
    // Count attempts before native decoding. Counters contain only keyed hashes,
    // and use the reverse-proxy-validated request IP, never arbitrary headers.
    await this.prisma.$transaction(async (tx) => {
      await this.rateLimit(
        tx,
        "ip-hour",
        `${ip}:${now.toISOString().slice(0, 13)}`,
        12,
        now,
      );
      await this.rateLimit(
        tx,
        "attempt-global-hour",
        now.toISOString().slice(0, 13),
        200,
        now,
      );
    });
    const image = await this.photos.normalize(data.certificateBase64);
    const phoneHash = this.crypto.hashPhoneVerification(
      "technician-intake-phone",
      data.phone,
    );
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const retry = await tx.technicianIntakeApplication.findUnique({
            where: { submissionKeyHash: keyHash },
            select: { id: true, requestHash: true },
          });
          if (retry) return receipt(retry);
          const organizations = await tx.organization.findMany({
            where: { services: { some: { published: true } } },
            select: { id: true },
            take: 2,
          });
          if (organizations.length !== 1)
            throw new ServiceUnavailableException(
              "入驻通道暂未配置，请联系平台客服",
            );
          await this.rateLimit(
            tx,
            "phone-day",
            `${phoneHash}:${now.toISOString().slice(0, 10)}`,
            3,
            now,
          );
          await this.rateLimit(
            tx,
            "submission-global-day",
            now.toISOString().slice(0, 10),
            100,
            now,
          );
          const row = await tx.technicianIntakeApplication.create({
            data: {
              id,
              organizationId: organizations[0]!.id,
              nameEncrypted: this.crypto.encryptScoped(
                `technician-intake:${id}:name`,
                data.name,
              ),
              phoneEncrypted: this.crypto.encryptScoped(
                `technician-intake:${id}:phone`,
                data.phone,
              ),
              phoneHash,
              certificateEncrypted: this.crypto.encryptScoped(
                `technician-intake:${id}:certificate`,
                Buffer.from(image.content).toString("base64"),
              ),
              certificateDigest: image.digest,
              submissionKeyHash: keyHash,
              requestHash,
              consentVersion: CONSENT_VERSION,
              consentAcceptedAt: now,
              status: "PENDING_REVIEW",
            },
            select: { id: true, requestHash: true },
          });
          await tx.auditLog.create({
            data: {
              organizationId: organizations[0]!.id,
              action: "TECHNICIAN_INTAKE_SUBMITTED",
              resourceType: "TechnicianIntakeApplication",
              resourceId: id,
              metadata: {
                consentVersion: CONSENT_VERSION,
                phoneVerified: false,
              },
            },
          });
          return receipt(row);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2034"].includes(error.code)
      ) {
        const retry = await this.prisma.technicianIntakeApplication.findUnique({
          where: { submissionKeyHash: keyHash },
          select: { id: true, requestHash: true },
        });
        if (retry) return receipt(retry);
        throw new ServiceUnavailableException("提交繁忙，请稍后重试同一次提交");
      }
      throw error;
    }
  }

  async certificate(
    principal: AuthPrincipal,
    organizationId: string,
    id: string,
  ) {
    this.assertAccess(principal, organizationId);
    this.assertId(id);
    const row = await this.prisma.technicianIntakeApplication.findFirst({
      where: { id, organizationId },
      select: { certificateEncrypted: true },
    });
    if (!row) throw new NotFoundException("未找到当前组织的申请");
    let content: Buffer;
    try {
      const base64 = this.crypto.decryptScoped(
        `technician-intake:${id}:certificate`,
        row.certificateEncrypted,
      );
      content = Buffer.from(base64, "base64");
      if (
        !content.length ||
        content.length > 512 * 1024 ||
        content[0] !== 0xff ||
        content[1] !== 0xd8
      )
        throw Error();
    } catch {
      throw new ServiceUnavailableException("证书照片暂时无法读取");
    }
    await this.prisma.auditLog.create({
      data: {
        actorId: principal.userId,
        organizationId,
        action: "TECHNICIAN_INTAKE_CERTIFICATE_VIEWED",
        resourceType: "TechnicianIntakeApplication",
        resourceId: id,
        metadata: {},
      },
    });
    return content;
  }

  async review(
    principal: AuthPrincipal,
    organizationId: string,
    id: string,
    action: "approve" | "reject",
    expectedVersion: number,
    reason?: string,
  ) {
    this.assertAccess(principal, organizationId);
    this.assertId(id);
    if (
      !principal.mfaVerifiedUntil ||
      principal.mfaVerifiedUntil.getTime() <= Date.now()
    )
      throw new ForbiddenException("此敏感操作需要先在账户安全完成动态码验证");
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1 ||
      (action === "reject" &&
        (!reason || reason.trim().length < 2 || reason.trim().length > 500))
    )
      throw new BadRequestException("审核版本或拒绝原因无效");
    const status = action === "approve" ? "APPROVED" : "REJECTED";
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.technicianIntakeApplication.findFirst({
        where: { id, organizationId },
        select: { id: true },
      });
      if (!found) throw new NotFoundException("未找到当前组织的申请");
      const result = await tx.technicianIntakeApplication.updateMany({
        where: {
          id,
          organizationId,
          status: "PENDING_REVIEW",
          version: expectedVersion,
        },
        data: {
          status,
          version: { increment: 1 },
          reviewedAt: new Date(),
          reviewedById: principal.userId,
          rejectionReason: action === "reject" ? reason!.trim() : null,
        },
      });
      if (result.count !== 1)
        throw new ConflictException("申请状态或资料版本已变化，请刷新后重试");
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: `TECHNICIAN_INTAKE_${status}`,
          resourceType: "TechnicianIntakeApplication",
          resourceId: id,
          metadata: {
            fromStatus: "PENDING_REVIEW",
            toStatus: status,
            expectedVersion,
          },
        },
      });
      // Reviewing intake is deliberately not account provisioning, publication,
      // scheduling or permission assignment.
      return { technicianId: id, status, version: expectedVersion + 1 };
    });
  }

  private assertAccess(principal: AuthPrincipal, organizationId: string) {
    if (
      !principal.memberships.some(
        (row) =>
          row.organizationId === organizationId &&
          ["ADMIN", "OPERATOR"].includes(row.role),
      ) ||
      ["CUSTOMER_SMS", "TECHNICIAN_PHONE"].includes(
        principal.authChannel ?? "",
      ) ||
      ["customer-sms", "technician-sms"].includes(principal.authProvider ?? "")
    )
      throw new ForbiddenException("请使用已授权的后台管理账号登录");
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
  }
  private assertId(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new BadRequestException("申请编号无效");
  }
  private async rateLimit(
    tx: Tx,
    scope: string,
    value: string,
    maximum: number,
    now: Date,
  ) {
    const key = this.crypto.hashPhoneVerification(
      `technician-intake-rate:${scope}`,
      value,
    );
    const counter = await tx.phoneVerificationRateLimit.upsert({
      where: { key },
      create: {
        key,
        count: 1,
        expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60_000),
      },
      update: { count: { increment: 1 } },
    });
    if (counter.count > maximum)
      throw new HttpException(
        "提交次数较多，请稍后重试",
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }
}

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, type MfaCredential } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import { createTotpSecret, matchTotp } from "./totp.js";

const ADMIN_ROLES = [
  "THERAPIST",
  "OPERATOR",
  "DISPATCHER",
  "FINANCE_REQUESTER",
  "FINANCE_APPROVER",
  "SAFETY_DUTY",
  "ADMIN",
];
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly config: ConfigService,
  ) {}

  async status(principal: AuthPrincipal) {
    const credential = await this.prisma.mfaCredential.findUnique({
      where: { userId: principal.userId },
    });
    return {
      enabled: !!credential?.enabledAt,
      enrollmentPending:
        !!credential &&
        !credential.enabledAt &&
        credential.enrollmentExpiresAt!.getTime() > Date.now(),
      lockedUntil: credential?.lockedUntil?.toISOString() ?? null,
      verifiedUntil: principal.mfaVerifiedUntil?.toISOString() ?? null,
      required:
        this.config.get("NODE_ENV") === "production" ||
        this.config.get("STAFF_MFA_REQUIRED") === "true",
      staffEligible: principal.memberships.some((m) =>
        ADMIN_ROLES.includes(m.role),
      ),
    };
  }

  private async context(
    tx: Prisma.TransactionClient,
    principal: AuthPrincipal,
    now: Date,
    fresh = false,
  ) {
    // One user lock serializes enrollment, every verifier instance and the global replay counter.
    // NO KEY UPDATE still serializes verifiers, but is compatible with audit/session FK reads
    // during concurrent logout. FOR UPDATE here would invert the Session/User lock order.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR NO KEY UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: principal.userId },
      include: { memberships: { where: { status: "ACTIVE" } } },
    });
    const session = await tx.session.findUnique({
      where: { id: principal.sessionId },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      session.expiresAt <= now
    )
      throw new UnauthorizedException("会话已失效");
    if (!user.memberships.some((m) => ADMIN_ROLES.includes(m.role)))
      throw new ForbiddenException("只有已授权后台人员可以使用MFA");
    if (
      fresh &&
      (session.createdAt.getTime() < now.getTime() - 300_000 ||
        session.createdAt > now)
    )
      throw new UnauthorizedException("绑定验证器前请重新完成微信登录");
    return session;
  }

  private locked(credential: MfaCredential | null, now: Date) {
    if (credential?.lockedUntil && credential.lockedUntil > now)
      throw new UnauthorizedException("动态码验证已暂时锁定，请五分钟后重试");
  }

  async enroll(principal: AuthPrincipal, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await this.context(tx, principal, now, true);
      const existing = await tx.mfaCredential.findUnique({
        where: { userId: principal.userId },
      });
      this.locked(existing, now);
      if (existing?.enabledAt)
        throw new ConflictException("验证器已绑定；禁止直接替换或关闭");
      if (existing?.enrollmentExpiresAt && existing.enrollmentExpiresAt > now)
        throw new ConflictException(
          "已有待激活绑定，丢失密钥请等待十分钟后重新绑定",
        );
      const secret = createTotpSecret(),
        expiresAt = new Date(now.getTime() + 600_000);
      const data = {
        secretEncrypted: this.crypto.encrypt(secret),
        enrollmentSessionId: principal.sessionId,
        enrollmentExpiresAt: expiresAt,
        failedAttempts: 0,
        lockedUntil: null,
      };
      await tx.mfaCredential.upsert({
        where: { userId: principal.userId },
        create: { userId: principal.userId, ...data },
        update: data,
      });
      await this.audit(tx, principal, "MFA_ENROLLMENT_STARTED");
      // Return the provisioning secret only here, under a fresh authenticated session. Never audit it.
      return {
        secret,
        expiresAt: expiresAt.toISOString(),
        issuer: "中原到家",
        accountName: principal.userId,
      };
    });
  }

  async verify(
    principal: AuthPrincipal,
    code: string,
    activate: boolean,
    now = new Date(),
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await this.context(tx, principal, now);
      const credential = await tx.mfaCredential.findUnique({
        where: { userId: principal.userId },
      });
      this.locked(credential, now);
      if (
        !credential ||
        (activate ? !!credential.enabledAt : !credential.enabledAt)
      )
        throw new ConflictException(
          activate ? "没有可激活的绑定" : "请先绑定验证器",
        );
      if (
        activate &&
        (credential.enrollmentSessionId !== principal.sessionId ||
          !credential.enrollmentExpiresAt ||
          credential.enrollmentExpiresAt <= now)
      )
        throw new UnauthorizedException("绑定已过期或不属于当前登录会话");
      const step = matchTotp(
        this.crypto.decrypt(credential.secretEncrypted),
        code,
        now,
        credential.lastAcceptedStep,
      );
      if (step === null) {
        const expiredLock =
          !!credential.lockedUntil && credential.lockedUntil <= now;
        const attempts = (expiredLock ? 0 : credential.failedAttempts) + 1;
        await tx.mfaCredential.update({
          where: { userId: principal.userId },
          data: {
            failedAttempts: attempts,
            lockedUntil:
              attempts >= 5 ? new Date(now.getTime() + 300_000) : null,
          },
        });
        await this.audit(tx, principal, "MFA_VERIFICATION_FAILED");
        return null; // Throw OUTSIDE the transaction so the failure counter cannot roll back.
      }
      const verifiedUntil = new Date(
        Math.min(now.getTime() + 300_000, session.expiresAt.getTime()),
      );
      const updated = await tx.session.updateMany({
        where: {
          id: session.id,
          userId: principal.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { mfaVerifiedUntil: verifiedUntil },
      });
      if (updated.count !== 1) throw new UnauthorizedException("会话已失效");
      await tx.mfaCredential.update({
        where: { userId: principal.userId },
        data: {
          lastAcceptedStep: step,
          failedAttempts: 0,
          lockedUntil: null,
          ...(activate
            ? {
                enabledAt: now,
                enrollmentSessionId: null,
                enrollmentExpiresAt: null,
              }
            : {}),
        },
      });
      await this.audit(
        tx,
        principal,
        activate ? "MFA_ENABLED" : "MFA_VERIFIED",
      );
      return { verifiedUntil: verifiedUntil.toISOString() };
    });
    if (!result) throw new UnauthorizedException("动态码无效、过期或已被使用");
    return result;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    principal: AuthPrincipal,
    action: string,
  ) {
    await tx.auditLog.create({
      data: {
        actorId: principal.userId,
        action,
        resourceType: "MfaCredential",
        resourceId: principal.userId,
        metadata: { sessionId: principal.sessionId },
      },
    });
  }
}

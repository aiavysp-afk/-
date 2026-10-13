import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type Session,
  type StaffTrustedDevice,
  type User,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";

const TRUST_DAYS = 7;
const TRUST_MS = TRUST_DAYS * 86_400_000;
const MAX_ACTIVE_DEVICES = 10;
type TrustSession = Pick<
  Session,
  | "id"
  | "userId"
  | "trustedDeviceId"
  | "staffVerificationMethod"
  | "staffVerifiedUntil"
>;
type TrustUser = Pick<User, "id">;

@Injectable()
export class TrustedDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly config: ConfigService,
  ) {}

  configuration() {
    return {
      enabled:
        this.config.get("STAFF_TRUSTED_DEVICE_ENABLED") === "true" &&
        !(
          this.config.get("NODE_ENV") === "production" &&
          this.config.get("AUTH_PROVIDER") !== "wechat"
        ),
      maxDays: TRUST_DAYS,
    };
  }

  private gate() {
    if (!this.configuration().enabled)
      throw new ServiceUnavailableException("常用设备登录尚未开放");
  }

  private agentHash(userAgent: string | undefined) {
    if (!userAgent || userAgent.length > 1024)
      throw new BadRequestException("无法识别当前浏览器设备");
    return this.crypto.hashBrowserLogin("trusted-device-agent", userAgent);
  }

  private phoneHash(user: Pick<User, "phoneEncrypted" | "phoneVerifiedAt">) {
    if (!user.phoneEncrypted || !user.phoneVerifiedAt) return null;
    try {
      return this.crypto.hashPhoneVerification(
        "phone",
        this.crypto.decrypt(user.phoneEncrypted),
      );
    } catch {
      return null;
    }
  }

  private view(row: StaffTrustedDevice) {
    // Never serialize device tokens, hashes, phone hashes, or MFA snapshots.
    return {
      id: row.id,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }

  private async context(
    tx: Prisma.TransactionClient,
    actor: Pick<AuthPrincipal, "userId" | "sessionId">,
    now: Date,
    fresh = false,
  ) {
    // All enrollment, acceptance, validation and revocation share this order.
    // Password/MFA changes also take the User lock before changing credentials.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.userId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${actor.sessionId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: actor.userId },
      include: { memberships: { where: { status: "ACTIVE" } } },
    });
    const session = await tx.session.findUnique({
      where: { id: actor.sessionId },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.createdAt > now
    )
      throw new UnauthorizedException("登录状态已失效，请重新登录");
    if (!user.memberships.some((membership) => membership.role !== "CUSTOMER"))
      throw new ForbiddenException("只有已授权工作人员可以管理常用设备");
    if (session.authChannel !== "ADMIN_BROWSER")
      throw new ForbiddenException("请在本人运营后台管理常用设备");
    if (fresh && session.createdAt.getTime() < now.getTime() - 300_000)
      throw new UnauthorizedException("请先重新完成微信或密码登录");
    const [mfa, password] = await Promise.all([
      tx.mfaCredential.findUnique({ where: { userId: user.id } }),
      tx.staffPasswordCredential.findUnique({ where: { userId: user.id } }),
    ]);
    if (
      session.staffPasswordVersion !== null &&
      session.staffPasswordVersion !== undefined &&
      session.staffPasswordVersion !== (password?.version ?? 0)
    )
      throw new UnauthorizedException("工作人员密码已变化，请重新登录");
    return { user, session, mfa, password, phoneHash: this.phoneHash(user) };
  }

  async register(
    actor: AuthPrincipal,
    label: string | undefined,
    userAgent: string | undefined,
    now = new Date(),
  ) {
    this.gate();
    const userAgentHash = this.agentHash(userAgent);
    const safeLabel = label?.trim() || "常用设备";
    if (safeLabel.length > 80)
      throw new BadRequestException("设备名称不能超过80个字符");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.crypto.hashBrowserLogin(
      "trusted-device-token",
      token,
    );
    const device = await this.prisma.$transaction(async (tx) => {
      const context = await this.context(tx, actor, now);
      if (
        !context.session.mfaVerifiedUntil ||
        context.session.mfaVerifiedUntil <= now ||
        !context.mfa?.enabledAt
      )
        throw new UnauthorizedException("请先完成本次独立验证器动态码验证");
      if (!context.phoneHash)
        throw new ForbiddenException("请先验证本人手机号码");
      const activeDevices = await tx.staffTrustedDevice.count({
        where: {
          userId: context.user.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (activeDevices >= MAX_ACTIVE_DEVICES)
        throw new ConflictException(
          "常用设备最多保留10台，请先撤销不再使用的设备",
        );
      const row = await tx.staffTrustedDevice.create({
        data: {
          userId: context.user.id,
          tokenHash,
          userAgentHash,
          label: safeLabel,
          createdAt: now,
          expiresAt: new Date(now.getTime() + TRUST_MS),
          mfaEnabledAtSnapshot: context.mfa.enabledAt,
          passwordVersion: context.password?.version ?? 0,
          phoneHash: context.phoneHash,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.user.id,
          action: "AUTH_TRUSTED_DEVICE_REGISTERED",
          resourceType: "StaffTrustedDevice",
          resourceId: row.id,
          metadata: { expiresAt: row.expiresAt.toISOString() },
        },
      });
      return this.view(row);
    });
    // Controller consumes the secret only to issue an HttpOnly cookie.
    return { device, token };
  }

  private validDevice(
    row: StaffTrustedDevice | null,
    context: Awaited<ReturnType<TrustedDeviceService["context"]>>,
    now: Date,
  ) {
    return (
      !!row &&
      row.userId === context.user.id &&
      !row.revokedAt &&
      row.createdAt <= now &&
      row.expiresAt > now &&
      !!context.mfa?.enabledAt &&
      row.mfaEnabledAtSnapshot.getTime() === context.mfa.enabledAt.getTime() &&
      row.passwordVersion === (context.password?.version ?? 0) &&
      !!context.phoneHash &&
      row.phoneHash === context.phoneHash
    );
  }

  async accept(
    actor: AuthPrincipal,
    cookieToken: string | null,
    userAgent: string | undefined,
    now = new Date(),
  ) {
    this.gate();
    if (!cookieToken || !/^[A-Za-z0-9_-]{43}$/.test(cookieToken))
      return { trusted: false as const };
    const tokenHash = this.crypto.hashBrowserLogin(
      "trusted-device-token",
      cookieToken,
    );
    const userAgentHash = this.agentHash(userAgent);
    return this.prisma.$transaction(async (tx) => {
      const context = await this.context(tx, actor, now, true);
      const snapshot = await tx.staffTrustedDevice.findUnique({
        where: { tokenHash },
      });
      if (!snapshot || snapshot.userId !== context.user.id)
        return { trusted: false as const };
      await tx.$queryRaw`SELECT "id" FROM "StaffTrustedDevice" WHERE "id" = ${snapshot.id} FOR UPDATE`;
      const row = await tx.staffTrustedDevice.findUnique({
        where: { id: snapshot.id },
      });
      if (
        !this.validDevice(row, context, now) ||
        row!.userAgentHash !== userAgentHash
      )
        return { trusted: false as const };
      await tx.staffTrustedDevice.update({
        where: { id: row!.id },
        data: { lastUsedAt: now },
      });
      const verifiedUntil = new Date(
        Math.min(context.session.expiresAt.getTime(), row!.expiresAt.getTime()),
      );
      await tx.session.update({
        where: { id: context.session.id },
        data: {
          staffVerifiedUntil: verifiedUntil,
          staffVerificationMethod: "TRUSTED_DEVICE",
          trustedDeviceId: row!.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.user.id,
          action: "AUTH_TRUSTED_DEVICE_ACCEPTED",
          resourceType: "StaffTrustedDevice",
          resourceId: row!.id,
          metadata: { sessionId: context.session.id },
        },
      });
      return {
        trusted: true as const,
        verifiedUntil: verifiedUntil.toISOString(),
      };
    });
  }

  async list(actor: AuthPrincipal, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      await this.context(tx, actor, now);
      const rows = await tx.staffTrustedDevice.findMany({
        where: { userId: actor.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return rows.map((row) => this.view(row));
    });
  }

  async revoke(actor: AuthPrincipal, deviceId: string, now = new Date()) {
    // Revocation remains available even when the feature has been disabled.
    return this.prisma.$transaction(async (tx) => {
      const context = await this.context(tx, actor, now);
      await tx.$queryRaw`SELECT "id" FROM "StaffTrustedDevice" WHERE "id" = ${deviceId} FOR UPDATE`;
      const row = await tx.staffTrustedDevice.findUnique({
        where: { id: deviceId },
      });
      if (!row || row.userId !== context.user.id)
        throw new NotFoundException("常用设备不存在");
      const updated = row.revokedAt
        ? row
        : await tx.staffTrustedDevice.update({
            where: { id: row.id },
            data: { revokedAt: now },
          });
      await tx.session.updateMany({
        where: { userId: context.user.id, trustedDeviceId: row.id },
        data: {
          staffVerifiedUntil: null,
          staffVerificationMethod: null,
          trustedDeviceId: null,
        },
      });
      if (!row.revokedAt)
        await tx.auditLog.create({
          data: {
            actorId: context.user.id,
            action: "AUTH_TRUSTED_DEVICE_REVOKED",
            resourceType: "StaffTrustedDevice",
            resourceId: row.id,
            metadata: {},
          },
        });
      return { device: this.view(updated) };
    });
  }

  async validateSessionTrust(
    session: TrustSession,
    user: TrustUser,
    now = new Date(),
  ): Promise<boolean> {
    if (
      !this.configuration().enabled ||
      session.userId !== user.id ||
      session.staffVerificationMethod !== "TRUSTED_DEVICE" ||
      !session.trustedDeviceId ||
      !session.staffVerifiedUntil ||
      session.staffVerifiedUntil <= now
    )
      return false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const context = await this.context(
          tx,
          { userId: user.id, sessionId: session.id },
          now,
        );
        const current = context.session;
        if (
          current.staffVerificationMethod !== "TRUSTED_DEVICE" ||
          !current.trustedDeviceId ||
          !current.staffVerifiedUntil ||
          current.staffVerifiedUntil <= now ||
          current.trustedDeviceId !== session.trustedDeviceId
        )
          return false;
        await tx.$queryRaw`SELECT "id" FROM "StaffTrustedDevice" WHERE "id" = ${current.trustedDeviceId} FOR UPDATE`;
        const row = await tx.staffTrustedDevice.findUnique({
          where: { id: current.trustedDeviceId },
        });
        return this.validDevice(row, context, now);
      });
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      )
        return false;
      throw error;
    }
  }
}

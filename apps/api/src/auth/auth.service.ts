import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdentityProvider, MembershipStatus, UserRole } from "@prisma/client";
import type {
  AuthSession,
  WechatPhoneVerificationResult,
} from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import {
  WechatMiniappClient,
  type WechatIdentityResult,
} from "./wechat-miniapp.client.js";
import { TrustedDeviceService } from "./trusted-device.service.js";
import { CustomerPhoneIdentityService } from "./customer-phone-identity.service.js";
import { withBoundedAuthTransaction } from "./bounded-auth-transaction.js";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly wechat: WechatMiniappClient,
    private readonly config: ConfigService<AppEnv, true>,
    @Optional() private readonly trustedDevices?: TrustedDeviceService,
    @Optional() private readonly phones?: CustomerPhoneIdentityService,
  ) {}

  async loginWithWechat(code: string): Promise<AuthSession> {
    const identity = await this.wechat.exchangeCode(code);
    const appId = this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true });
    if (identity.unionId) {
      const userId = await this.resolveUnionIdentity(
        IdentityProvider.WECHAT_MINIAPP,
        appId,
        { ...identity, unionId: identity.unionId },
      );
      const external = await this.prisma.externalIdentity.findUniqueOrThrow({
        where: {
          provider_subjectHash: {
            provider: IdentityProvider.WECHAT_MINIAPP,
            subjectHash: this.crypto.hashIdentity(appId, identity.openId),
          },
        },
        select: { id: true },
      });
      return this.createSessionForUser(
        userId,
        "WECHAT_MINIAPP",
        this.config.get("AUTH_PROVIDER", { infer: true }),
        external.id,
      );
    }
    const subjectHash = this.crypto.hashIdentity(appId, identity.openId);
    const sessionToken = this.crypto.createSessionToken();
    const tokenHash = this.crypto.hashSessionToken(sessionToken);
    const ttlSeconds = this.config.get("AUTH_SESSION_TTL_SECONDS", {
      infer: true,
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);

    const result = await this.prisma.$transaction(async (tx) => {
      const externalIdentity = await tx.externalIdentity.upsert({
        where: {
          provider_subjectHash: {
            provider: IdentityProvider.WECHAT_MINIAPP,
            subjectHash,
          },
        },
        create: {
          provider: IdentityProvider.WECHAT_MINIAPP,
          subjectHash,
          subjectEncrypted: this.crypto.encrypt(identity.openId),
          unionIdHash: identity.unionId
            ? this.crypto.hashIdentity("unionid", identity.unionId)
            : undefined,
          unionIdEncrypted: identity.unionId
            ? this.crypto.encrypt(identity.unionId)
            : undefined,
          user: {
            create: {
              role: UserRole.CUSTOMER,
              displayName: "微信用户",
            },
          },
        },
        update: {},
        include: {
          user: {
            include: {
              memberships: { where: { status: MembershipStatus.ACTIVE } },
            },
          },
        },
      });
      const user = externalIdentity.user;
      if (user.status !== "ACTIVE")
        throw new UnauthorizedException("账号不可用");

      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
          authChannel: "WECHAT_MINIAPP",
          authProvider: this.config.get("AUTH_PROVIDER", { infer: true }),
          wechatIdentityId: externalIdentity.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "AUTH_WECHAT_LOGIN",
          resourceType: "User",
          resourceId: user.id,
          metadata: {
            provider: IdentityProvider.WECHAT_MINIAPP,
          },
        },
      });
      return user;
    });

    return {
      accessToken: sessionToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: result.id,
        displayName: result.displayName,
        phoneVerified: Boolean(result.phoneEncrypted && result.phoneVerifiedAt),
        memberships: result.memberships.map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
        })),
      },
    };
  }

  async identifyWechatH5(identity: WechatIdentityResult): Promise<string> {
    if (!identity.unionId) {
      throw new UnauthorizedException("未获取到UnionID，不能安全绑定技师账号");
    }
    return this.resolveUnionIdentity(
      IdentityProvider.WECHAT_H5,
      this.config.get("TECHNICIAN_H5_APP_ID", { infer: true }),
      { ...identity, unionId: identity.unionId },
    );
  }

  async createSessionForUser(
    userId: string,
    authChannel: "WECHAT_MINIAPP" | "WECHAT_H5",
    authProvider = "wechat",
    wechatIdentityId?: string,
  ): Promise<AuthSession> {
    const sessionToken = this.crypto.createSessionToken();
    const tokenHash = this.crypto.hashSessionToken(sessionToken);
    const ttlSeconds = this.config.get("AUTH_SESSION_TTL_SECONDS", {
      infer: true,
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        include: {
          memberships: { where: { status: MembershipStatus.ACTIVE } },
        },
      });
      if (!current || current.status !== "ACTIVE") {
        throw new UnauthorizedException("账号不可用");
      }
      await tx.session.create({
        data: {
          userId,
          tokenHash,
          expiresAt,
          authChannel,
          authProvider,
          ...(wechatIdentityId ? { wechatIdentityId } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: "AUTH_WECHAT_LOGIN",
          resourceType: "User",
          resourceId: userId,
          metadata: { provider: authChannel },
        },
      });
      return current;
    });
    return {
      accessToken: sessionToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        displayName: user.displayName,
        phoneVerified: Boolean(user.phoneEncrypted && user.phoneVerifiedAt),
        memberships: user.memberships.map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
        })),
      },
    };
  }

  async verifyWechatPhone(
    principal: AuthPrincipal,
    code: string,
  ): Promise<WechatPhoneVerificationResult> {
    const { phoneNumber } = await this.wechat.exchangePhoneCode(code);
    const phoneVerifiedAt = new Date();
    if (!this.phones)
      throw new ServiceUnavailableException("手机号身份绑定服务未就绪");
    await withBoundedAuthTransaction(this.prisma, async (tx) => {
      await this.phones!.bindVerifiedPhone(
        tx,
        principal.userId,
        phoneNumber,
        phoneVerifiedAt,
      );
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_WECHAT_PHONE_VERIFIED",
          resourceType: "User",
          resourceId: principal.userId,
          metadata: { provider: IdentityProvider.WECHAT_MINIAPP },
        },
      });
    });
    return {
      phoneVerified: true,
      maskedPhone: `${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-4)}`,
    };
  }

  async authenticate(accessToken: string): Promise<AuthPrincipal> {
    if (accessToken.length < 32 || accessToken.length > 256) {
      throw new UnauthorizedException("登录状态无效");
    }
    const tokenHash = this.crypto.hashSessionToken(accessToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: { where: { status: MembershipStatus.ACTIVE } },
          },
        },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.status !== "ACTIVE"
    ) {
      throw new UnauthorizedException("登录状态已失效，请重新登录");
    }
    const now = new Date();
    const customerSms = session.authProvider === "customer-sms";
    const technicianPhone =
      session.authChannel === "TECHNICIAN_PHONE" ||
      session.authProvider === "technician-sms";
    let phoneTechnicianOrganization: string | null = null;
    if (technicianPhone) {
      if (
        session.authChannel !== "TECHNICIAN_PHONE" ||
        session.authProvider !== "technician-sms" ||
        this.config.get("TECHNICIAN_PHONE_LOGIN_ENABLED", { infer: true }) !==
          "true" ||
        session.wechatIdentityId ||
        session.mfaVerifiedUntil ||
        session.staffVerifiedUntil ||
        session.staffVerificationMethod ||
        session.staffPasswordVersion ||
        session.trustedDeviceId ||
        !session.customerPhoneHash ||
        !session.user.phoneEncrypted ||
        !session.user.phoneVerifiedAt
      )
        throw new UnauthorizedException("技师手机号登录已失效，请重新登录");
      let phoneHash: string;
      try {
        phoneHash = this.crypto.hashPhoneVerification(
          "phone",
          this.crypto.decrypt(session.user.phoneEncrypted),
        );
      } catch {
        throw new UnauthorizedException("手机号安全资料已变更，请重新登录");
      }
      const binding = await this.prisma.customerPhoneIdentity.findUnique({
        where: { userId: session.userId },
        select: { phoneHash: true },
      });
      if (
        phoneHash !== session.customerPhoneHash ||
        binding?.phoneHash !== phoneHash
      )
        throw new UnauthorizedException("手机号安全资料已变更，请重新登录");
      if (
        this.config.get("TECHNICIAN_PHONE_WORKBENCH_ENABLED", {
          infer: true,
        }) === "true"
      ) {
        const profile = await this.prisma.technicianProfile.findUnique({
          where: { technicianId: session.userId },
          select: { organizationId: true, status: true },
        });
        if (profile && ["APPROVED", "PUBLISHED"].includes(profile.status))
          phoneTechnicianOrganization = profile.organizationId;
      }
    }
    if (
      customerSms &&
      (session.authChannel !== "CUSTOMER_SMS" ||
        session.wechatIdentityId ||
        !session.user.phoneEncrypted ||
        !session.user.phoneVerifiedAt ||
        this.config.get("CUSTOMER_SMS_LOGIN_ENABLED", { infer: true }) !==
          "true")
    )
      throw new UnauthorizedException("手机号登录状态无效，请重新登录");
    if (session.authChannel === "CUSTOMER_SMS" && !customerSms)
      throw new UnauthorizedException("登录状态无效");
    if (customerSms) {
      let currentPhoneHash: string;
      try {
        currentPhoneHash = this.crypto.hashPhoneVerification(
          "phone",
          this.crypto.decrypt(session.user.phoneEncrypted!),
        );
      } catch {
        throw new UnauthorizedException("手机号安全资料已变更，请重新登录");
      }
      if (
        !session.customerPhoneHash ||
        session.customerPhoneHash !== currentPhoneHash
      )
        throw new UnauthorizedException("手机号安全资料已变更，请重新登录");
    }
    let staffVerifiedUntil: Date | null = null;
    let staffVerificationMethod: string | null = null;
    if (session.authProvider === "staff-password") {
      if (
        this.config.get("STAFF_PASSWORD_LOGIN_ENABLED", { infer: true }) !==
          "true" ||
        session.authChannel !== "ADMIN_BROWSER" ||
        !["PASSWORD_SMS", "TRUSTED_DEVICE"].includes(
          session.staffVerificationMethod ?? "",
        ) ||
        !session.user.phoneEncrypted ||
        !session.user.phoneVerifiedAt ||
        !session.user.memberships.some(
          (membership) => membership.role !== "CUSTOMER",
        )
      )
        throw new UnauthorizedException(
          "账号密码登录已失效，请使用微信重新登录",
        );
      const credential = await this.prisma.staffPasswordCredential.findUnique({
        where: { userId: session.userId },
        select: { version: true, phoneHash: true },
      });
      let phoneHash: string;
      try {
        phoneHash = this.crypto.hashPhoneVerification(
          "phone",
          this.crypto.decrypt(session.user.phoneEncrypted),
        );
      } catch {
        throw new UnauthorizedException("账户安全信息已变更，请重新登录");
      }
      if (
        !credential ||
        credential.version !== session.staffPasswordVersion ||
        credential.phoneHash !== phoneHash
      )
        throw new UnauthorizedException("账户安全信息已变更，请重新登录");
    }
    if (
      session.authChannel === "ADMIN_BROWSER" &&
      session.staffVerifiedUntil &&
      session.staffVerifiedUntil > now &&
      session.user.memberships.some(
        (membership) => membership.role !== "CUSTOMER",
      )
    ) {
      const passwordVerified =
        session.authProvider === "staff-password" &&
        session.staffVerificationMethod === "PASSWORD_SMS";
      const deviceVerified =
        session.staffVerificationMethod === "TRUSTED_DEVICE" &&
        !!this.trustedDevices &&
        (await this.trustedDevices.validateSessionTrust(
          session,
          session.user,
          now,
        ));
      if (passwordVerified || deviceVerified) {
        staffVerifiedUntil = new Date(
          Math.min(
            session.staffVerifiedUntil.getTime(),
            session.expiresAt.getTime(),
          ),
        );
        staffVerificationMethod = session.staffVerificationMethod;
      }
    }
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
    return {
      sessionId: session.id,
      userId: session.user.id,
      displayName: session.user.displayName,
      mfaVerifiedUntil:
        customerSms || technicianPhone ? null : session.mfaVerifiedUntil,
      staffVerifiedUntil,
      staffVerificationMethod,
      staffPasswordVersion:
        customerSms || technicianPhone ? null : session.staffPasswordVersion,
      trustedDeviceId:
        staffVerificationMethod === "TRUSTED_DEVICE"
          ? session.trustedDeviceId
          : null,
      authChannel: session.authChannel,
      authProvider: session.authProvider,
      wechatIdentityId:
        customerSms || technicianPhone
          ? null
          : (session.wechatIdentityId ?? null),
      phoneVerified: Boolean(
        session.user.phoneEncrypted && session.user.phoneVerifiedAt,
      ),
      memberships: session.user.memberships
        .filter((membership) =>
          technicianPhone
            ? membership.role === UserRole.THERAPIST &&
              membership.organizationId === phoneTechnicianOrganization
            : !customerSms || membership.role === UserRole.CUSTOMER,
        )
        .map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
        })),
    };
  }

  async logout(principal: AuthPrincipal) {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: {
          id: principal.sessionId,
          userId: principal.userId,
          revokedAt: null,
        },
        data: { revokedAt },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_LOGOUT",
          resourceType: "Session",
          resourceId: principal.sessionId,
          metadata: {},
        },
      }),
    ]);
    return { loggedOut: true };
  }

  private async resolveUnionIdentity(
    provider: IdentityProvider,
    appId: string,
    identity: WechatIdentityResult & { unionId: string },
  ) {
    const subjectHash = this.crypto.hashIdentity(appId, identity.openId);
    const unionIdHash = this.crypto.hashIdentity("unionid", identity.unionId);
    const subjectEncrypted = this.crypto.encrypt(identity.openId);
    const unionIdEncrypted = this.crypto.encrypt(identity.unionId);
    return this.prisma.$transaction(async (tx) => {
      // The unique binding is the durable invariant; the advisory lock avoids
      // creating and rolling back competing users under concurrent callbacks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${unionIdHash}, 0))`;
      const [external, binding] = await Promise.all([
        tx.externalIdentity.findUnique({
          where: { provider_subjectHash: { provider, subjectHash } },
        }),
        tx.wechatUnionIdentity.findUnique({ where: { unionIdHash } }),
      ]);
      if (external?.unionIdHash && external.unionIdHash !== unionIdHash) {
        throw new ConflictException("微信身份绑定冲突，请联系平台处理");
      }
      if (external && binding && external.userId !== binding.userId) {
        throw new ConflictException("微信UnionID已绑定其他账号");
      }

      let userId = external?.userId ?? binding?.userId;
      if (!userId) {
        const user = await tx.user.create({
          data: { role: UserRole.CUSTOMER, displayName: "微信用户" },
          select: { id: true },
        });
        userId = user.id;
      }
      if (!binding) {
        await tx.wechatUnionIdentity.create({
          data: { unionIdHash, unionIdEncrypted, userId },
        });
      }
      if (!external) {
        await tx.externalIdentity.create({
          data: {
            provider,
            subjectHash,
            subjectEncrypted,
            unionIdHash,
            unionIdEncrypted,
            userId,
          },
        });
      } else if (!external.unionIdHash) {
        await tx.externalIdentity.update({
          where: { id: external.id },
          data: { unionIdHash, unionIdEncrypted },
        });
      }
      return userId;
    });
  }
}

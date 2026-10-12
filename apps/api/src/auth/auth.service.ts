import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
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
import { WechatMiniappClient, type WechatIdentityResult } from "./wechat-miniapp.client.js";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly wechat: WechatMiniappClient,
    private readonly config: ConfigService<AppEnv, true>,
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
      return this.createSessionForUser(userId, "WECHAT_MINIAPP", "wechat");
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
        phoneVerified: Boolean(
          result.phoneEncrypted && result.phoneVerifiedAt,
        ),
        memberships: result.memberships.map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
        })),
      },
    };
  }

  async identifyWechatH5(identity: WechatIdentityResult): Promise<string> {
    if (!identity.unionId) {
      throw new UnauthorizedException(
        "未获取到UnionID，不能安全绑定技师账号",
      );
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
    const phoneEncrypted = this.crypto.encrypt(phoneNumber);
    const phoneVerifiedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: principal.userId },
        data: { phoneEncrypted, phoneVerifiedAt },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_WECHAT_PHONE_VERIFIED",
          resourceType: "User",
          resourceId: principal.userId,
          metadata: { provider: IdentityProvider.WECHAT_MINIAPP },
        },
      }),
    ]);
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
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
    return {
      sessionId: session.id,
      userId: session.user.id,
      displayName: session.user.displayName,
      mfaVerifiedUntil: session.mfaVerifiedUntil,
      authChannel: session.authChannel,
      authProvider: session.authProvider,
      phoneVerified: Boolean(session.user.phoneEncrypted && session.user.phoneVerifiedAt),
      memberships: session.user.memberships.map((membership) => ({
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
      if (
        external?.unionIdHash &&
        external.unionIdHash !== unionIdHash
      ) {
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

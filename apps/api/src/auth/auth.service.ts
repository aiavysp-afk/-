import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdentityProvider, MembershipStatus, UserRole } from "@prisma/client";
import type { AuthSession } from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import { WechatMiniappClient } from "./wechat-miniapp.client.js";

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
        data: { userId: user.id, tokenHash, expiresAt },
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
        memberships: result.memberships.map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
        })),
      },
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
}

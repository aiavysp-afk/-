import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdentityProvider } from "@prisma/client";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";

/** The payer is the WeChat identity that authenticated this session, not the
 * first WeChat identity attached to the canonical customer account. */
@Injectable()
export class WechatPayerResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly crypto: AuthCryptoService,
  ) {}

  async resolveOpenId(principal: AuthPrincipal): Promise<string> {
    // A verified phone proves possession of that phone, never possession of an
    // existing WeChat identity. It must not confer payment or staff authority.
    if (
      principal.authProvider !== "wechat" ||
      principal.authChannel !== "WECHAT_MINIAPP"
    ) {
      throw new ForbiddenException(
        "微信支付需要切换微信一键登录，请重新登录后支付",
      );
    }
    if (principal.wechatIdentityId) {
      const identity = await this.prisma.externalIdentity.findUnique({
        where: { id: principal.wechatIdentityId },
      });
      if (
        !identity ||
        identity.userId !== principal.userId ||
        identity.provider !== IdentityProvider.WECHAT_MINIAPP
      )
        throw this.notReady();
      const openId = this.validOpenId(identity);
      if (!openId) throw this.notReady();
      return openId;
    }

    // Existing sessions predate session-bound identities. They retain support
    // only when exactly one valid identity belongs to the current app. Fetching
    // a bounded arbitrary first row would become unsafe after account linking.
    const identities = await this.prisma.externalIdentity.findMany({
      where: {
        userId: principal.userId,
        provider: IdentityProvider.WECHAT_MINIAPP,
      },
    });
    const matching = identities
      .map((identity) => this.validOpenId(identity))
      .filter((value): value is string => !!value);
    if (matching.length !== 1) throw this.notReady();
    return matching[0]!;
  }

  hashOpenId(openId: string) {
    return this.crypto.hashIdentity(
      this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
      openId,
    );
  }

  private validOpenId(identity: {
    subjectEncrypted: string;
    subjectHash: string;
  }) {
    try {
      const subject = this.crypto.decrypt(identity.subjectEncrypted);
      if (
        subject.length > 0 &&
        subject.length <= 128 &&
        !subject.startsWith("mock-") &&
        this.hashOpenId(subject) === identity.subjectHash
      )
        return subject;
    } catch {
      // Never leak ciphertext, openid, or decryption/provider error details.
    }
    return null;
  }

  private notReady() {
    return new ServiceUnavailableException(
      "当前小程序微信身份未就绪，请切换微信一键登录",
    );
  }
}

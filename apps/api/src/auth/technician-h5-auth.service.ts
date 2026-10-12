import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import type { AuthSession } from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthService } from "./auth.service.js";
import { WechatH5Client } from "./wechat-h5.client.js";

const STATE_TTL_MS = 10 * 60 * 1_000;
const TICKET_TTL_MS = 2 * 60 * 1_000;

@Injectable()
export class TechnicianH5AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly auth: AuthService,
    private readonly wechat: WechatH5Client,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async begin() {
    const state = randomBytes(32).toString("base64url");
    const browserBinding = randomBytes(32).toString("base64url");
    // Fail before persisting state if either side of the fixed redirect flow is
    // not ready. The API itself can still start with the feature disabled.
    const authorizeUrl = this.wechat.authorizeUrl(state);
    this.entryUrl();
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.technicianH5OAuthState.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }),
      this.prisma.technicianH5OAuthState.create({
        data: {
          stateHash: this.hash("state", state),
          browserBindingHash: this.hash("browser", browserBinding),
          expiresAt,
        },
      }),
    ]);
    return {
      authorizeUrl,
      browserBinding,
      maxAgeSeconds: Math.floor(STATE_TTL_MS / 1_000),
    };
  }

  async callback(code: string, state: string, browserBinding?: string) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(code)) {
      throw new BadRequestException("微信授权code无效");
    }
    if (
      !/^[A-Za-z0-9_-]{40,64}$/.test(state) ||
      !browserBinding ||
      !/^[A-Za-z0-9_-]{40,64}$/.test(browserBinding)
    ) {
      throw new UnauthorizedException("微信OAuth state或浏览器绑定无效");
    }
    const now = new Date();
    const stateHash = this.hash("state", state);
    const bindingHash = this.hash("browser", browserBinding);
    const consumed = await this.prisma.technicianH5OAuthState.updateMany({
      where: {
        stateHash,
        browserBindingHash: bindingHash,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException("微信OAuth state已使用、过期或不属于当前浏览器");
    }

    const identity = await this.wechat.exchangeOauthCode(code);
    const userId = await this.auth.identifyWechatH5(identity);
    const ticket = randomBytes(32).toString("base64url");
    const ticketHash = this.hash("ticket", ticket);
    await this.prisma.$transaction([
      this.prisma.technicianH5LoginTicket.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      this.prisma.technicianH5LoginTicket.create({
        data: {
          tokenHash: ticketHash,
          userId,
          expiresAt: new Date(now.getTime() + TICKET_TTL_MS),
        },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: "AUTH_WECHAT_H5_OAUTH_COMPLETED",
          resourceType: "User",
          resourceId: userId,
          metadata: { ticketIssued: true },
        },
      }),
    ]);
    const entry = this.entryUrl();
    entry.hash = `/wechat-callback?ticket=${encodeURIComponent(ticket)}`;
    return entry.toString();
  }

  async exchange(ticket: string): Promise<AuthSession> {
    const now = new Date();
    const tokenHash = this.hash("ticket", ticket);
    const row = await this.prisma.technicianH5LoginTicket.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, consumedAt: true },
    });
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedException("登录交换票据已使用或过期");
    }
    const changed = await this.prisma.technicianH5LoginTicket.updateMany({
      where: {
        id: row.id,
        tokenHash,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (changed.count !== 1) {
      throw new ConflictException("登录交换票据状态已变化，请重新扫码");
    }
    return this.auth.createSessionForUser(row.userId, "WECHAT_H5");
  }

  configurationUnavailableRedirectUrl() {
    const entry = this.entryUrl();
    entry.hash = "/configuration-unavailable";
    return entry.toString();
  }

  private hash(kind: string, value: string) {
    return this.crypto.hashBrowserLogin(`technician-h5:${kind}`, value);
  }

  private entryUrl() {
    try {
      const url = new URL(
        this.config.get("TECHNICIAN_H5_ENTRY_URL", { infer: true }),
      );
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("invalid entry URL");
      }
      return url;
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "CONFIGURATION_NOT_READY",
        message: "技师H5入驻地址配置未就绪",
      });
    }
  }
}

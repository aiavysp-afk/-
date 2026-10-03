import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type BrowserLoginChallenge } from "@prisma/client";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";

@Injectable()
export class BrowserLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly config: ConfigService,
  ) {}
  configuration() {
    const enabled =
      this.config.get("STAFF_BROWSER_LOGIN_ENABLED") === "true" &&
      !(
        this.config.get("NODE_ENV") === "production" &&
        this.config.get("AUTH_PROVIDER") !== "wechat"
      );
    return {
      enabled,
      provider: this.config.get("AUTH_PROVIDER"),
      audience: "中原到家运营后台",
      expiresInSeconds: 180,
    };
  }
  private gate() {
    if (!this.configuration().enabled)
      throw new ServiceUnavailableException("后台微信配对登录尚未开放");
  }
  assertBrowserOrigin(origin?: string) {
    const allowed = String(this.config.get("CORS_ORIGINS") ?? "")
      .split(",")
      .map((x) => x.trim());
    if (
      (origin && !allowed.includes(origin)) ||
      (this.config.get("NODE_ENV") === "production" &&
        (!origin || !origin.startsWith("https://")))
    )
      throw new ForbiddenException("后台登录来源不受信任");
  }
  private async take(
    purpose: string,
    subject: string,
    limit: number,
    now: Date,
    windowMs = 3_600_000,
  ) {
    const bucket = Math.floor(now.getTime() / windowMs);
    const key = this.crypto.hashBrowserLogin(
      "rate",
      `${purpose}:${subject}:${bucket}`,
    );
    const expiresAt = new Date((bucket + 2) * windowMs);
    const row = await this.prisma.browserLoginRateLimit.upsert({
      where: { key },
      create: { key, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
    if (row.count > limit)
      throw new HttpException("登录请求过于频繁，请稍后重试", 429);
  }
  async create(remoteAddress: string, now = new Date()) {
    this.gate();
    // Socket peer only, never caller-controlled X-Forwarded-For. Shared proxies share this budget.
    await this.take("global-create", "all", 1000, now);
    await this.take("peer-create", remoteAddress, 60, now);
    // Ephemeral pairing/rate material only; permanent Session and AuditLog are not deleted.
    await this.prisma.browserLoginChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
    });
    await this.prisma.browserLoginRateLimit.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const pairCode = randomBytes(16).toString("base64url"),
      browserSecret = this.crypto.createSessionToken();
    const confirmationCode = randomInt(0, 1_000_000)
      .toString()
      .padStart(6, "0");
    const expiresAt = new Date(now.getTime() + 180_000);
    await this.prisma.browserLoginChallenge.create({
      data: {
        id: pairCode,
        browserSecretHash: this.crypto.hashBrowserLogin(
          "device",
          browserSecret,
        ),
        confirmationHash: this.crypto.hashBrowserLogin(
          "confirm",
          confirmationCode,
        ),
        createdAt: now,
        expiresAt,
      },
    });
    return {
      pairCode,
      browserSecret,
      confirmationCode,
      expiresAt: expiresAt.toISOString(),
      pollIntervalSeconds: 2,
      ...this.configuration(),
    };
  }
  private async challenge(tx: Prisma.TransactionClient, id: string, now: Date) {
    await tx.$queryRaw`SELECT "id" FROM "BrowserLoginChallenge" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.browserLoginChallenge.findUnique({ where: { id } });
    if (!row || row.expiresAt <= now)
      throw new UnauthorizedException("登录配对已过期或无效，请重新发起");
    return row;
  }
  private proof(row: BrowserLoginChallenge, secret: string) {
    const hash = this.crypto.hashBrowserLogin("device", secret);
    if (!timingSafeEqual(Buffer.from(hash), Buffer.from(row.browserSecretHash)))
      throw new UnauthorizedException("登录配对凭证无效");
  }
  private async staff(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
    now: Date,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${sessionId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { status: "ACTIVE" } } },
    });
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.createdAt > now ||
      session.createdAt.getTime() < now.getTime() - 300_000 ||
      session.authChannel !== "WECHAT_MINIAPP" ||
      session.authProvider !== this.config.get("AUTH_PROVIDER")
    )
      throw new UnauthorizedException("请在小程序重新完成微信登录后确认");
    if (!user.memberships.some((m) => m.role !== "CUSTOMER"))
      throw new ForbiddenException("只有已授权工作人员可以登录后台");
    return { user, session };
  }
  async inspect(principal: AuthPrincipal, pairCode: string, now = new Date()) {
    this.gate();
    await this.take("phone", principal.userId, 30, now, 600_000);
    return this.prisma.$transaction(async (tx) => {
      await this.staff(tx, principal.userId, principal.sessionId, now);
      const row = await this.challenge(tx, pairCode, now);
      if (row.status !== "PENDING")
        throw new ConflictException("配对已处理，请重新发起");
      return {
        audience: this.configuration().audience,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        provider: this.configuration().provider,
      };
    });
  }
  async approve(
    principal: AuthPrincipal,
    pairCode: string,
    confirmationCode: string,
    now = new Date(),
  ) {
    this.gate();
    await this.take("phone", principal.userId, 30, now, 600_000);
    const accepted = await this.prisma.$transaction(async (tx) => {
      await this.staff(tx, principal.userId, principal.sessionId, now);
      const row = await this.challenge(tx, pairCode, now);
      if (row.status !== "PENDING")
        throw new ConflictException("配对已处理，请重新发起");
      const valid = timingSafeEqual(
        Buffer.from(this.crypto.hashBrowserLogin("confirm", confirmationCode)),
        Buffer.from(row.confirmationHash),
      );
      if (!valid) {
        const failures = row.failedAttempts + 1;
        await tx.browserLoginChallenge.update({
          where: { id: pairCode },
          data: {
            failedAttempts: failures,
            ...(failures === 5 ? { status: "CANCELLED" } : {}),
          },
        });
        return false;
      }
      await tx.browserLoginChallenge.update({
        where: { id: pairCode },
        data: {
          status: "APPROVED",
          approvedUserId: principal.userId,
          approvedSessionId: principal.sessionId,
          approvedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          action: "AUTH_BROWSER_APPROVED",
          resourceType: "Session",
          resourceId: principal.sessionId,
          metadata: { audience: "admin-browser" },
        },
      });
      return true;
    });
    if (!accepted)
      throw new UnauthorizedException("核对数字不一致；五次错误将取消本次配对");
    return { approved: true };
  }
  async poll(pairCode: string, browserSecret: string, now = new Date()) {
    this.gate();
    return this.prisma.$transaction(async (tx) => {
      const row = await this.challenge(tx, pairCode, now);
      this.proof(row, browserSecret);
      if (row.status === "CONSUMED" || row.status === "CANCELLED")
        return { status: row.status };
      if (row.lastPolledAt && row.lastPolledAt.getTime() > now.getTime() - 2000)
        throw new HttpException("请按两秒间隔检查登录状态", 429);
      await tx.browserLoginChallenge.update({
        where: { id: pairCode },
        data: { lastPolledAt: now },
      });
      return { status: row.status }; // Never expose identity, tokens or confirmation digits here.
    });
  }
  async cancel(pairCode: string, browserSecret: string, now = new Date()) {
    this.gate();
    return this.prisma.$transaction(async (tx) => {
      const row = await this.challenge(tx, pairCode, now);
      this.proof(row, browserSecret);
      if (row.status === "CONSUMED")
        throw new ConflictException("配对已领取，请注销后台会话");
      if (row.status !== "CANCELLED")
        await tx.browserLoginChallenge.update({
          where: { id: pairCode },
          data: { status: "CANCELLED" },
        });
      return { cancelled: true };
    });
  }
  async claim(pairCode: string, browserSecret: string, now = new Date()) {
    this.gate();
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.browserLoginChallenge.findUnique({
        where: { id: pairCode },
      });
      if (!snapshot) throw new UnauthorizedException("配对无效");
      this.proof(snapshot, browserSecret);
      if (
        snapshot.status !== "APPROVED" ||
        !snapshot.approvedUserId ||
        !snapshot.approvedSessionId
      )
        throw new ConflictException("登录未批准或已领取");
      // User -> source Session -> challenge order matches approval and MFA; logout can linearize first.
      const { user, session } = await this.staff(
        tx,
        snapshot.approvedUserId,
        snapshot.approvedSessionId,
        now,
      );
      const row = await this.challenge(tx, pairCode, now);
      this.proof(row, browserSecret);
      if (row.status !== "APPROVED")
        throw new ConflictException("登录已领取或取消");
      const accessToken = this.crypto.createSessionToken(),
        expiresAt = new Date(
          Math.min(now.getTime() + 3_600_000, session.expiresAt.getTime()),
        );
      const browserSession = await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: this.crypto.hashSessionToken(accessToken),
          expiresAt,
          createdAt: now,
          authChannel: "ADMIN_BROWSER",
          authProvider: session.authProvider,
          mfaVerifiedUntil: null,
        },
      });
      await tx.browserLoginChallenge.update({
        where: { id: pairCode },
        data: {
          status: "CONSUMED",
          claimedSessionId: browserSession.id,
          consumedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "AUTH_BROWSER_CLAIMED",
          resourceType: "Session",
          resourceId: browserSession.id,
          metadata: { sourceSessionId: session.id },
        },
      });
      return {
        accessToken,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: user.id,
          displayName: user.displayName,
          memberships: user.memberships.map((m) => ({
            organizationId: m.organizationId,
            role: m.role,
          })),
        },
      };
    });
  }
}

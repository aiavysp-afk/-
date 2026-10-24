import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { WechatMiniappClient } from "../auth/wechat-miniapp.client.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";

const GRANT = "TECHNICIAN_WECHAT_SUBSCRIPTION";
const NOTICE = "TECHNICIAN_WECHAT_ORDER";
const ACTIVE = ["PAID", "DISPATCHING", "ASSIGNED"] as const;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function notificationSettings(config: ConfigService<AppEnv, true>) {
  const templateId =
    config.get("TECHNICIAN_WECHAT_TEMPLATE_ID", { infer: true }) || "";
  const service =
    config.get("TECHNICIAN_WECHAT_SERVICE_FIELD", { infer: true }) || "";
  const time =
    config.get("TECHNICIAN_WECHAT_TIME_FIELD", { infer: true }) || "";
  const notice =
    config.get("TECHNICIAN_WECHAT_NOTICE_FIELD", { infer: true }) || "";
  const ready =
    config.get("TECHNICIAN_WECHAT_NOTIFICATIONS_ENABLED", { infer: true }) ===
      "true" &&
    config.get("AUTH_PROVIDER", { infer: true }) === "wechat" &&
    Boolean(config.get("WECHAT_MINIAPP_SECRET", { infer: true })) &&
    /^[A-Za-z0-9_-]{20,128}$/.test(templateId) &&
    /^thing\d+$/.test(service) &&
    /^time\d+$/.test(time) &&
    /^thing\d+$/.test(notice) &&
    service !== notice;
  return { ready, templateId, service, time, notice };
}

/** Separate typed events in the durable outbox. A grant is consumed only once.
 * Provider acceptance is not device delivery. Unknown sends are never retried. */
@Injectable()
export class TechnicianNotificationsService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(TechnicianNotificationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly crypto: AuthCryptoService,
    private readonly wechat: WechatMiniappClient,
  ) {}

  async identity(principal: AuthPrincipal) {
    if (
      principal.authChannel !== "WECHAT_MINIAPP" ||
      principal.authProvider !== "wechat" ||
      !principal.phoneVerified ||
      !principal.wechatIdentityId
    )
      throw new ForbiddenException("请在小程序使用本人微信登录后订阅订单提醒");
    const identity = await this.prisma.externalIdentity.findFirst({
      where: {
        id: principal.wechatIdentityId,
        userId: principal.userId,
        provider: "WECHAT_MINIAPP",
        user: {
          status: "ACTIVE",
          technicianProfile: { status: { in: ["APPROVED", "PUBLISHED"] } },
        },
      },
      select: {
        id: true,
        user: {
          select: {
            technicianProfile: { select: { organizationId: true } },
            memberships: {
              where: { role: "THERAPIST", status: "ACTIVE" },
              select: { organizationId: true },
            },
          },
        },
      },
    });
    const organizationId = identity?.user.technicianProfile?.organizationId;
    if (
      !identity ||
      !organizationId ||
      !identity.user.memberships.some(
        (m) => m.organizationId === organizationId,
      )
    )
      throw new ForbiddenException("审核通过的技师才可订阅本人订单提醒");
    return { id: identity.id, organizationId };
  }
  async capabilities(principal: AuthPrincipal) {
    await this.identity(principal);
    const settings = notificationSettings(this.config);
    return {
      enabled: settings.ready,
      templateId: settings.ready ? settings.templateId : null,
      message: settings.ready
        ? "每次同意订阅可接收一次新订单提醒，请定期补充订阅。"
        : "微信订单提醒正在配置，当前请在工作台查看订单。",
    };
  }
  async subscribe(
    principal: AuthPrincipal,
    requestId: string,
    templateId: string,
  ) {
    const identity = await this.identity(principal);
    const settings = notificationSettings(this.config);
    if (!settings.ready || templateId !== settings.templateId)
      throw new ServiceUnavailableException("微信订单提醒尚未配置完成");
    // This acknowledgement is not treated as WeChat authorization evidence:
    // the provider independently checks the recipient's actual subscription.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`wx-subscription:${principal.userId}`}))`;
      const id = `wx-grant-${hash(`${principal.userId}:${requestId}`)}`;
      if (await tx.outboxEvent.findUnique({ where: { id } })) return;
      const count = await tx.outboxEvent.count({
        where: {
          type: GRANT,
          aggregateId: principal.userId,
          createdAt: { gte: new Date(Date.now() - 86400_000) },
        },
      });
      if (count >= 30)
        throw new ForbiddenException("今日订阅登记次数已达上限，请明日再试");
      await tx.outboxEvent.create({
        data: {
          id,
          type: GRANT,
          aggregateId: principal.userId,
          organizationId: identity.organizationId,
          payload: { identityId: identity.id, templateId },
        },
      });
    });
    return { registered: true };
  }
  onModuleInit() {
    if (!notificationSettings(this.config).ready) return;
    this.timer = setInterval(() => void this.run(), 15000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async run(now = new Date()) {
    if (this.running || !notificationSettings(this.config).ready) return;
    this.running = true;
    try {
      await this.prisma.outboxEvent.updateMany({
        where: {
          type: NOTICE,
          publishedAt: null,
          deadLetteredAt: null,
          dispatchStartedAt: { lt: new Date(now.getTime() - 60_000) },
        },
        data: { deadLetteredAt: now, lastErrorCode: "OUTCOME_UNKNOWN" },
      });
      const grants = await this.prisma.outboxEvent.findMany({
        where: {
          type: GRANT,
          publishedAt: null,
          nextAttemptAt: { lte: now },
          createdAt: { gte: new Date(now.getTime() - 7 * 86400_000) },
          payload: {
            path: ["templateId"],
            equals: notificationSettings(this.config).templateId,
          },
        },
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
        take: 100,
      });
      for (const grant of grants)
        await this.deliverNext(grant.id, grant.aggregateId, now);
    } catch {
      this.logger.warn(
        "微信订单提醒处理未完成，请检查通知记录；不会自动重复发送未知结果",
      );
    } finally {
      this.running = false;
    }
  }
  async deliverNext(grantId: string, userId: string, now: Date) {
    const settings = notificationSettings(this.config);
    if (!settings.ready) return;
    const reserved = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`wx-subscription:${userId}`}))`;
      const grant = await tx.outboxEvent.findUnique({ where: { id: grantId } });
      if (
        !grant ||
        grant.type !== GRANT ||
        grant.aggregateId !== userId ||
        grant.publishedAt ||
        grant.createdAt < new Date(now.getTime() - 7 * 86400_000)
      )
        return null;
      const payload = grant.payload as {
        identityId?: string;
        templateId?: string;
      };
      if (!payload.identityId || payload.templateId !== settings.templateId)
        return null;
      // Rotate unused grants so a busy first page cannot starve other technicians.
      await tx.outboxEvent.updateMany({
        where: { id: grantId, publishedAt: null },
        data: { nextAttemptAt: new Date(now.getTime() + 60_000) },
      });
      const identity = await tx.externalIdentity.findFirst({
        where: {
          id: payload.identityId,
          userId,
          provider: "WECHAT_MINIAPP",
          user: {
            status: "ACTIVE",
            memberships: {
              some: {
                organizationId: grant.organizationId!,
                role: "THERAPIST",
                status: "ACTIVE",
              },
            },
            technicianProfile: {
              organizationId: grant.organizationId!,
              status: { in: ["APPROVED", "PUBLISHED"] },
            },
          },
        },
      });
      if (!identity) return null;
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT o."id" FROM "Order" o WHERE o."therapistId" = ${userId}
        AND o."organizationId" = ${grant.organizationId} AND o."status" IN ('PAID','DISPATCHING','ASSIGNED')
        AND o."appointmentStart" > ${now}
        AND EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o."id" AND p."status" = 'SUCCEEDED' AND p."provider" = 'WECHAT')
        AND EXISTS (SELECT 1 FROM "OrderEvent" e WHERE e."orderId" = o."id" AND e."type" IN ('PAYMENT_SUCCEEDED','THERAPIST_ASSIGNED') AND e."createdAt" >= ${grant.createdAt})
        AND NOT EXISTS (SELECT 1 FROM "OutboxEvent" n WHERE n."type" = ${NOTICE} AND n."aggregateId" = o."id")
        ORDER BY o."createdAt" ASC LIMIT 1 FOR UPDATE OF o SKIP LOCKED`;
      if (!candidates[0]) return null;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: candidates[0].id },
        include: { items: true, payment: true },
      });
      if (
        order.therapistId !== userId ||
        !ACTIVE.includes(order.status as (typeof ACTIVE)[number]) ||
        !order.items[0]
      )
        return null;
      const id = `wx-order-${hash(order.id)}`;
      await tx.outboxEvent.create({
        data: {
          id,
          type: NOTICE,
          organizationId: order.organizationId,
          aggregateId: order.id,
          payload: { technicianId: userId, grantId },
          dispatchStartedAt: now,
          attempts: 1,
        },
      });
      await tx.outboxEvent.update({
        where: { id: grantId },
        data: { publishedAt: now },
      });
      return {
        id,
        subjectEncrypted: identity.subjectEncrypted,
        serviceName: order.items[0].serviceName,
        appointmentStart: order.appointmentStart,
      };
    });
    if (!reserved) return;
    let outcome: "ACCEPTED" | "REJECTED" | "UNKNOWN" = "UNKNOWN";
    try {
      const date = new Date(reserved.appointmentStart.getTime() + 8 * 3600000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      outcome = await this.wechat.sendSubscription({
        openId: this.crypto.decrypt(reserved.subjectEncrypted),
        templateId: settings.templateId,
        state:
          this.config.get("TECHNICIAN_WECHAT_MINIPROGRAM_STATE", {
            infer: true,
          }) || "formal",
        data: {
          [settings.service]: {
            value: [...reserved.serviceName].slice(0, 20).join(""),
          },
          [settings.time]: { value: date },
          [settings.notice]: { value: "您有新订单，请进入工作台查看" },
        },
      });
    } catch {
      /* A crash or transport failure never grants permission to resend. */
    }
    await this.prisma.outboxEvent.updateMany({
      where: { id: reserved.id, publishedAt: null, deadLetteredAt: null },
      data:
        outcome === "ACCEPTED"
          ? { publishedAt: new Date(), lastErrorCode: "PROVIDER_ACCEPTED" }
          : {
              deadLetteredAt: new Date(),
              lastErrorCode:
                outcome === "REJECTED"
                  ? "PROVIDER_REJECTED"
                  : "OUTCOME_UNKNOWN",
            },
    });
  }
}

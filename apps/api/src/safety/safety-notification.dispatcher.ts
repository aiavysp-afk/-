import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";

const Payload = z.object({
  incidentId: z.string().min(1),
  primaryUserId: z.string().min(1).optional(),
  backupUserId: z.string().min(1).optional(),
});

export type SafetyDispatchResult =
  | {
      outcome: "ACCEPTED";
      providerReference: string;
      providerBizId: string;
    }
  | { outcome: "RETRY"; errorCode: string }
  | { outcome: "DEAD_LETTER"; errorCode: string };

@Injectable()
export class SafetyNotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly sms: AliyunSmsClient,
  ) {}

  async dispatch(outboxId: string): Promise<SafetyDispatchResult> {
    const outbox = await this.prisma.outboxEvent.findUnique({
      where: { id: outboxId },
    });
    if (!outbox) return { outcome: "DEAD_LETTER", errorCode: "EVENT_MISSING" };
    if (
      !["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"].includes(
        outbox.type,
      )
    )
      return {
        outcome: "DEAD_LETTER",
        errorCode: "UNSUPPORTED_EVENT_TYPE",
      };
    const payload = Payload.safeParse(outbox.payload);
    if (!payload.success)
      return { outcome: "DEAD_LETTER", errorCode: "INVALID_EVENT_PAYLOAD" };
    const incident = await this.prisma.safetyIncident.findUnique({
      where: { id: payload.data.incidentId },
      include: { order: { select: { orderNo: true } } },
    });
    if (!incident || incident.id !== outbox.aggregateId)
      return { outcome: "DEAD_LETTER", errorCode: "INCIDENT_MISSING" };
    const targetUserId =
      outbox.type === "SAFETY_INCIDENT_OPENED"
        ? payload.data.primaryUserId
        : payload.data.backupUserId;
    const expectedUserId =
      outbox.type === "SAFETY_INCIDENT_OPENED"
        ? incident.primaryUserId
        : incident.backupUserId;
    if (!targetUserId || targetUserId !== expectedUserId)
      return { outcome: "DEAD_LETTER", errorCode: "TARGET_MISMATCH" };
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { phoneEncrypted: true, status: true },
    });
    if (!target || target.status !== "ACTIVE" || !target.phoneEncrypted)
      return {
        outcome: "DEAD_LETTER",
        errorCode: "TARGET_PHONE_UNAVAILABLE",
      };
    let phone = "";
    try {
      phone = this.crypto.decrypt(target.phoneEncrypted);
    } catch {
      return {
        outcome: "DEAD_LETTER",
        errorCode: "TARGET_PHONE_INVALID",
      };
    }
    if (!/^1[3-9]\d{9}$/.test(phone))
      return {
        outcome: "DEAD_LETTER",
        errorCode: "TARGET_PHONE_INVALID",
      };
    try {
      const receipt = await this.sms.submit({
        phone,
        trackingId: outbox.id,
        parameters: {
          orderNo: incident.order.orderNo,
          category: incident.category,
          stage:
            outbox.type === "SAFETY_INCIDENT_OPENED"
              ? "PRIMARY"
              : "BACKUP_ESCALATION",
          deadline: incident.acknowledgementDueAt.toISOString(),
        },
      });
      if (receipt.status === "ACCEPTED")
        return {
          outcome: "ACCEPTED",
          providerReference: `${receipt.requestId}:${receipt.bizId}`,
          providerBizId: receipt.bizId,
        };
      if (receipt.status === "REJECTED")
        return { outcome: "RETRY", errorCode: "SMS_REJECTED" };
      return {
        outcome: "DEAD_LETTER",
        errorCode: "SMS_ACCEPTANCE_UNKNOWN",
      };
    } catch {
      return { outcome: "RETRY", errorCode: "SMS_CHANNEL_NOT_READY" };
    }
  }
}

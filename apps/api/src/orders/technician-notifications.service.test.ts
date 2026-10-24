import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import {
  TechnicianNotificationsService,
  notificationSettings,
} from "./technician-notifications.service.js";
const templateId = "fixture_template_not_a_real_template";
const config = (values = {}) =>
  new ConfigService({
    AUTH_PROVIDER: "wechat",
    WECHAT_MINIAPP_SECRET: "fixture-only",
    TECHNICIAN_WECHAT_NOTIFICATIONS_ENABLED: "true",
    TECHNICIAN_WECHAT_TEMPLATE_ID: templateId,
    TECHNICIAN_WECHAT_SERVICE_FIELD: "thing1",
    TECHNICIAN_WECHAT_TIME_FIELD: "time2",
    TECHNICIAN_WECHAT_NOTICE_FIELD: "thing3",
    ...values,
  }) as any;
const principal = {
  userId: "tech",
  authChannel: "WECHAT_MINIAPP",
  authProvider: "wechat",
  phoneVerified: true,
  wechatIdentityId: "identity",
} as any;
function fixture() {
  const now = new Date();
  const grant = {
    id: "grant",
    type: "TECHNICIAN_WECHAT_SUBSCRIPTION",
    organizationId: "org",
    aggregateId: "tech",
    createdAt: new Date(now.getTime() - 1000),
    publishedAt: null as Date | null,
    payload: { identityId: "identity", templateId },
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "order" }]),
    outboxEvent: {
      findUnique: vi.fn(async () => grant),
      create: vi.fn(),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => {
        grant.publishedAt = now;
      }),
      updateMany: vi.fn(),
    },
    externalIdentity: {
      findFirst: vi.fn(async () => ({
        id: "identity",
        subjectEncrypted: "encrypted-only",
        user: {
          technicianProfile: { organizationId: "org" },
          memberships: [{ organizationId: "org" }],
        },
      })),
    },
    order: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "order",
        organizationId: "org",
        therapistId: "tech",
        status: "PAID",
        items: [{ serviceName: "测试项目" }],
        appointmentStart: now,
      })),
    },
  };
  const prisma = { ...db, $transaction: vi.fn(async (op: any) => op(db)) };
  const sender = { sendSubscription: vi.fn(async () => "ACCEPTED") };
  const service = new TechnicianNotificationsService(
    prisma as any,
    config(),
    { decrypt: () => "fixture-openid" } as any,
    sender as any,
  );
  return { now, grant, db, sender, prisma, service };
}
describe("technician order WeChat subscriptions", () => {
  it("stays disabled without an exact template and separate switch", () => {
    expect(
      notificationSettings(
        config({ TECHNICIAN_WECHAT_NOTIFICATIONS_ENABLED: "false" }),
      ).ready,
    ).toBe(false);
    expect(
      notificationSettings(config({ TECHNICIAN_WECHAT_TEMPLATE_ID: "" })).ready,
    ).toBe(false);
    expect(
      notificationSettings(
        config({ TECHNICIAN_WECHAT_SERVICE_FIELD: "phone_number1" }),
      ).ready,
    ).toBe(false);
    expect(
      notificationSettings(config({ TECHNICIAN_WECHAT_NOTICE_FIELD: "thing1" }))
        .ready,
    ).toBe(false);
  });
  it.each(["CUSTOMER_SMS", "TECHNICIAN_PHONE", "ADMIN_BROWSER"])(
    "does not let %s assert WeChat permission",
    async (authChannel) => {
      const f = fixture();
      await expect(
        f.service.capabilities({ ...principal, authChannel }),
      ).rejects.toThrow("小程序");
      expect(f.prisma.externalIdentity.findFirst).not.toHaveBeenCalled();
    },
  );
  it("requires an approved active technician in the same organization", async () => {
    const f = fixture();
    f.db.externalIdentity.findFirst.mockResolvedValueOnce(null as any);
    await expect(f.service.capabilities(principal)).rejects.toThrow("审核通过");
  });
  it("consumes a grant and records durable dispatch before I/O, without private address or phone", async () => {
    const f = fixture();
    await f.service.deliverNext("grant", "tech", f.now);
    expect(f.db.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "TECHNICIAN_WECHAT_ORDER",
          attempts: 1,
        }),
      }),
    );
    expect(f.db.outboxEvent.update.mock.invocationCallOrder[0]).toBeLessThan(
      f.sender.sendSubscription.mock.invocationCallOrder[0]!,
    );
    expect(f.sender.sendSubscription).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.sender.sendSubscription.mock.calls)).not.toMatch(
      /address|phoneNumber|phoneEncrypted/,
    );
    expect(f.db.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastErrorCode: "PROVIDER_ACCEPTED" }),
      }),
    );
    await f.service.deliverNext("grant", "tech", f.now);
    expect(f.sender.sendSubscription).toHaveBeenCalledOnce();
  });
  it.each(["REJECTED", "UNKNOWN"])(
    "quarantines %s without a resend or false delivery claim",
    async (outcome) => {
      const f = fixture();
      f.sender.sendSubscription.mockResolvedValueOnce(outcome);
      await f.service.deliverNext("grant", "tech", f.now);
      expect(f.db.outboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deadLetteredAt: expect.any(Date) }),
        }),
      );
      await f.service.deliverNext("grant", "tech", f.now);
      expect(f.sender.sendSubscription).toHaveBeenCalledOnce();
    },
  );
  it("does not consume a grant when no current paid order exists", async () => {
    const f = fixture();
    f.db.$queryRaw.mockResolvedValue([]);
    await f.service.deliverNext("grant", "tech", f.now);
    expect(f.sender.sendSubscription).not.toHaveBeenCalled();
    expect(f.db.outboxEvent.update).not.toHaveBeenCalled();
  });
  it("does not send for reassignment or cancelled status at final check", async () => {
    const f = fixture();
    f.db.order.findUniqueOrThrow.mockResolvedValueOnce({
      id: "order",
      therapistId: "other",
      status: "CANCELLED",
    } as any);
    await f.service.deliverNext("grant", "tech", f.now);
    expect(f.sender.sendSubscription).not.toHaveBeenCalled();
  });
});

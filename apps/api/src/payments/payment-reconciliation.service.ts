import { BadRequestException, Injectable } from "@nestjs/common";
import { PaymentProvider } from "@prisma/client";
import { gunzipSync } from "node:zlib";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import { compareTradeBill, parseTradeBill } from "./trade-bill.js";

@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly client: WechatPayClient,
  ) {}

  async daily(principal: AuthPrincipal, organizationId: string, date: string) {
    this.access.assertPermission(principal, "finance.approve", organizationId);
    const from = new Date(`${date}T00:00:00+08:00`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(from.getTime()) ||
      new Date(from.getTime() + 8 * 3600_000).toISOString().slice(0, 10) !==
        date ||
      from.getTime() + 86400_000 > Date.now()
    )
      throw new BadRequestException("只能核对已结束的有效账单日期");
    const metadata = await this.client.requestTradeBill(date);
    const file = await this.client.downloadTradeBill(metadata);
    let bytes: Buffer = file;
    try {
      if (file[0] === 0x1f && file[1] === 0x8b)
        bytes = gunzipSync(file, { maxOutputLength: 20 * 1024 * 1024 });
    } catch {
      throw new BadRequestException("账单解压失败");
    }
    const config = this.client.verifierConfig();
    const rows = parseTradeBill(bytes).filter(
      (row) =>
        row.appId === config.appId && row.merchantId === config.merchantId,
    );
    if (rows.length > 10_000)
      throw new BadRequestException("账单超过当前在线核对容量，需分批离线核对");
    const local = await this.prisma.payment.findMany({
      where: {
        provider: PaymentProvider.WECHAT,
        order: { organizationId },
        OR: [
          {
            merchantPaymentNo: { in: rows.map((row) => row.merchantPaymentNo) },
          },
          {
            succeededAt: {
              gte: from,
              lt: new Date(from.getTime() + 86400_000),
            },
          },
        ],
      },
    });
    const recharges = await this.prisma.storedValueRecharge.findMany({
      where: {
        organizationId,
        OR: [
          {
            merchantPaymentNo: { in: rows.map((row) => row.merchantPaymentNo) },
          },
          {
            succeededAt: {
              gte: from,
              lt: new Date(from.getTime() + 86400_000),
            },
          },
        ],
      },
    });
    const allPayments = [...local, ...recharges];
    const ownIds = new Set(
      allPayments.map((payment) => payment.merchantPaymentNo),
    );
    // Merchant-wide bills can contain other businesses/organizations. Their IDs never escape this scope.
    const scoped = rows.filter((row) => ownIds.has(row.merchantPaymentNo));
    const localRefunds = await this.prisma.refund.findMany({
      where: {
        payment: {
          provider: PaymentProvider.WECHAT,
          order: { organizationId },
        },
        OR: [
          {
            merchantRefundNo: {
              in: scoped.map((row) => row.merchantRefundNo).filter(Boolean),
            },
          },
          {
            submittedAt: {
              gte: from,
              lt: new Date(from.getTime() + 86400_000),
            },
          },
        ],
        status: { not: "REJECTED" },
      },
      include: { payment: { select: { merchantPaymentNo: true } } },
    });
    const report = compareTradeBill(
      scoped,
      allPayments.map((payment) => ({
        ...payment,
        expectedOnDate:
          !!payment.succeededAt &&
          payment.succeededAt >= from &&
          payment.succeededAt < new Date(from.getTime() + 86400_000),
      })),
      localRefunds.map((refund) => ({
        ...refund,
        expectedOnDate:
          !!refund.submittedAt &&
          refund.submittedAt >= from &&
          refund.submittedAt < new Date(from.getTime() + 86400_000),
        merchantPaymentNo: refund.payment.merchantPaymentNo,
      })),
    );
    const merchantScopeReviewRequired = rows.some(
      (row) => !ownIds.has(row.merchantPaymentNo),
    );
    const result = {
      date,
      organizationId,
      fileHash: metadata.hashValue,
      ...report,
      matched: report.matched && !merchantScopeReviewRequired,
      merchantScopeReviewRequired,
    };
    await this.prisma.auditLog.create({
      data: {
        actorId: principal.userId,
        organizationId,
        action: "PAYMENT_DAILY_RECONCILIATION",
        resourceType: "PaymentReconciliation",
        metadata: result,
      },
    });
    return result;
  }
}

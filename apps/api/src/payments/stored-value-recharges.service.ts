import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  StoredValueRechargeStatus,
  WechatPrepayState,
  type StoredValueRecharge,
} from "@prisma/client";
import type {
  StoredValueRechargeCreate,
  StoredValueRechargeIntent,
} from "@zydj/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { PaymentGatewayService } from "./payment-gateway.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import {
  parseWechatTransaction,
  type WechatTransaction,
} from "./wechat-pay.protocol.js";
import { WechatPrepayService } from "./wechat-prepay.service.js";

const RECHARGE_WINDOW_MS = 15 * 60 * 1_000;
const RECHARGE_AMOUNTS = new Set([59_900, 88_800, 119_800, 288_800]);

@Injectable()
export class StoredValueRechargesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly gateway: PaymentGatewayService,
    private readonly client: WechatPayClient,
    private readonly prepay: WechatPrepayService,
  ) {}

  async createIntent(
    principal: AuthPrincipal,
    input: StoredValueRechargeCreate,
    idempotencyKey: string,
  ): Promise<StoredValueRechargeIntent> {
    this.assertEnabled();
    if (!RECHARGE_AMOUNTS.has(input.amountFen))
      throw new BadRequestException("充值金额不在可选档位内");
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      input.organizationId,
    );
    const fingerprint = createHash("sha256")
      .update(`${organizationId}:${input.amountFen}`)
      .digest("hex");
    const existing = await this.prisma.storedValueRecharge.findUnique({
      where: {
        customerId_idempotencyKey: {
          customerId: principal.userId,
          idempotencyKey,
        },
      },
    });
    if (existing) return this.replay(existing, fingerprint);

    const openId = await this.prepay.payerOpenId(principal.userId);
    const expiresAt = new Date(Date.now() + RECHARGE_WINDOW_MS);
    const merchantPaymentNo = `SVR${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`;
    const request = this.gateway.buildWechatJsapiRequest({
      description: `${this.config.get("BRAND_NAME", { infer: true })}-储值充值`,
      outTradeNo: merchantPaymentNo,
      totalFen: input.amountFen,
      payerOpenId: openId,
      expiresAt,
    });

    let recharge: StoredValueRecharge;
    try {
      recharge = await this.prisma.$transaction(async (tx) => {
        const account = await tx.storedValueAccount.upsert({
          where: {
            organizationId_customerId: {
              organizationId,
              customerId: principal.userId,
            },
          },
          create: { organizationId, customerId: principal.userId },
          update: {},
        });
        const created = await tx.storedValueRecharge.create({
          data: {
            organizationId,
            customerId: principal.userId,
            accountId: account.id,
            amountFen: BigInt(input.amountFen),
            merchantPaymentNo,
            prepayState: WechatPrepayState.DISPATCHING,
            prepayRequestedAt: new Date(),
            idempotencyKey,
            requestFingerprint: fingerprint,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId,
            action: "STORED_VALUE_PREPAY_DISPATCH_CLAIMED",
            resourceType: "StoredValueRecharge",
            resourceId: created.id,
            metadata: { amountFen: input.amountFen },
          },
        });
        return created;
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      const replay = await this.prisma.storedValueRecharge.findUnique({
        where: {
          customerId_idempotencyKey: {
            customerId: principal.userId,
            idempotencyKey,
          },
        },
      });
      if (!replay) throw error;
      return this.replay(replay, fingerprint);
    }

    let prepayId: string;
    try {
      prepayId = await this.client.prepay(request);
    } catch {
      await this.prisma.storedValueRecharge.updateMany({
        where: {
          id: recharge.id,
          prepayState: WechatPrepayState.DISPATCHING,
        },
        data: {
          status: StoredValueRechargeStatus.UNKNOWN,
          prepayState: WechatPrepayState.UNKNOWN,
          prepayFailureCode: "SUBMISSION_UNCERTAIN",
        },
      });
      throw new BadGatewayException(
        "微信充值预下单结果未确认，请查询原单；不会自动重复扣款",
      );
    }

    recharge = await this.prisma.storedValueRecharge.update({
      where: { id: recharge.id },
      data: {
        providerReference: prepayId,
        prepayState: WechatPrepayState.READY,
        prepayReadyAt: new Date(),
        prepayFailureCode: null,
      },
    });
    return this.toIntent(recharge);
  }

  async reconcile(principal: AuthPrincipal, rechargeId: string) {
    const recharge = await this.prisma.storedValueRecharge.findUnique({
      where: { id: rechargeId },
    });
    if (!recharge) throw new NotFoundException("充值记录不存在");
    if (recharge.customerId !== principal.userId)
      throw new ForbiddenException("不能查询其他用户的充值");
    if (recharge.status === StoredValueRechargeStatus.SUCCEEDED)
      return this.toIntent(recharge);
    const transaction = await this.client.queryTransaction(
      recharge.merchantPaymentNo,
    );
    if (
      transaction.out_trade_no !== recharge.merchantPaymentNo ||
      (transaction.amount?.total !== undefined &&
        BigInt(transaction.amount.total) !== recharge.amountFen)
    )
      throw new ConflictException("微信查单结果与充值记录不一致");
    if (transaction.trade_state === "SUCCESS") {
      await this.applyIfPresent(
        parseWechatTransaction(transaction, this.client.verifierConfig()),
        "QUERY",
      );
    }
    return this.toIntent(
      await this.prisma.storedValueRecharge.findUniqueOrThrow({
        where: { id: rechargeId },
      }),
    );
  }

  async applyIfPresent(
    transaction: WechatTransaction,
    source: "NOTIFICATION" | "QUERY",
  ) {
    const initial = await this.prisma.storedValueRecharge.findUnique({
      where: { merchantPaymentNo: transaction.out_trade_no },
    });
    if (!initial) return false;
    const identity = this.client.verifierConfig();
    if (
      transaction.appid !== identity.appId ||
      transaction.mchid !== identity.merchantId ||
      transaction.trade_type !== "JSAPI" ||
      transaction.trade_state !== "SUCCESS" ||
      !transaction.transaction_id ||
      !transaction.success_time ||
      transaction.amount.currency !== "CNY" ||
      BigInt(transaction.amount.total) !== initial.amountFen
    )
      throw new BadRequestException("微信充值交易与本地记录不一致");
    const succeededAt = new Date(transaction.success_time);
    if (
      !Number.isFinite(succeededAt.getTime()) ||
      succeededAt.getTime() > Date.now() + 300_000
    )
      throw new BadRequestException("微信充值成功时间无效");

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "StoredValueRecharge" WHERE "id" = ${initial.id} FOR UPDATE`;
      const current = await tx.storedValueRecharge.findUniqueOrThrow({
        where: { id: initial.id },
      });
      if (current.status === StoredValueRechargeStatus.SUCCEEDED) {
        if (current.providerTransactionId !== transaction.transaction_id)
          throw new ConflictException("微信充值流水冲突");
        return;
      }
      if (
        !new Set<StoredValueRechargeStatus>([
          StoredValueRechargeStatus.PENDING,
          StoredValueRechargeStatus.UNKNOWN,
        ]).has(current.status)
      )
        throw new ConflictException("当前充值状态不能入账");
      await tx.$queryRaw`SELECT "id" FROM "StoredValueAccount" WHERE "id" = ${current.accountId} FOR UPDATE`;
      const account = await tx.storedValueAccount.findUniqueOrThrow({
        where: { id: current.accountId },
      });
      const balanceAfterFen = account.balanceFen + current.amountFen;
      await tx.storedValueRecharge.update({
        where: { id: current.id },
        data: {
          status: StoredValueRechargeStatus.SUCCEEDED,
          providerTransactionId: transaction.transaction_id,
          succeededAt,
          prepayFailureCode: null,
        },
      });
      await tx.storedValueAccount.update({
        where: { id: account.id },
        data: { balanceFen: balanceAfterFen },
      });
      await tx.storedValueTransaction.create({
        data: {
          accountId: account.id,
          rechargeId: current.id,
          type: "RECHARGE",
          changeFen: current.amountFen,
          balanceAfterFen,
          description: "微信储值充值入账",
          occurredAt: succeededAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: current.customerId,
          organizationId: current.organizationId,
          action: "STORED_VALUE_RECHARGE_SUCCEEDED",
          resourceType: "StoredValueRecharge",
          resourceId: current.id,
          metadata: { source, amountFen: Number(current.amountFen) },
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: current.id,
          type: "STORED_VALUE_RECHARGE_SUCCEEDED",
          payload: { rechargeId: current.id, accountId: account.id },
        },
      });
    });
    return true;
  }

  private assertEnabled() {
    if (
      this.config.get("STORED_VALUE_RECHARGE_ENABLED", { infer: true }) !==
      "true"
    )
      throw new ServiceUnavailableException("储值充值通道维护中");
    this.client.assertPrepayEnabled();
  }

  private replay(
    recharge: StoredValueRecharge,
    requestFingerprint: string,
  ) {
    if (recharge.requestFingerprint !== requestFingerprint)
      throw new ConflictException("幂等键已用于其他充值请求");
    return this.toIntent(recharge);
  }

  private toIntent(
    recharge: StoredValueRecharge,
  ): StoredValueRechargeIntent {
    const amountFen = Number(recharge.amountFen);
    const ready =
      recharge.status === StoredValueRechargeStatus.PENDING &&
      recharge.prepayState === WechatPrepayState.READY &&
      !!recharge.providerReference &&
      !!recharge.prepayReadyAt &&
      recharge.expiresAt.getTime() > Date.now() &&
      recharge.prepayReadyAt.getTime() + 7_200_000 > Date.now();
    return {
      id: recharge.id,
      amountFen,
      status: recharge.status,
      expiresAt: recharge.expiresAt.toISOString(),
      prepayState: recharge.prepayState,
      ...(ready
        ? {
            wechatPayParameters: this.client.paymentParameters(
              recharge.providerReference!,
            ),
          }
        : {}),
    };
  }

  private async resolveOrganizationId(
    customerId: string,
    requestedOrganizationId?: string,
  ) {
    if (requestedOrganizationId) {
      const [organization, publishedService, priorOrder] = await Promise.all([
        this.prisma.organization.findUnique({
          where: { id: requestedOrganizationId },
          select: { id: true },
        }),
        this.prisma.service.findFirst({
          where: { organizationId: requestedOrganizationId, published: true },
          select: { id: true },
        }),
        this.prisma.order.findFirst({
          where: { organizationId: requestedOrganizationId, customerId },
          select: { id: true },
        }),
      ]);
      if (!organization) throw new NotFoundException("服务组织不存在");
      if (!publishedService && !priorOrder)
        throw new ForbiddenException("该服务组织暂不可用于储值充值");
      return requestedOrganizationId;
    }
    const latestOrder = await this.prisma.order.findFirst({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { organizationId: true },
    });
    if (latestOrder) return latestOrder.organizationId;
    const service = await this.prisma.service.findFirst({
      where: { published: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { organizationId: true },
    });
    if (!service) throw new NotFoundException("暂无可用服务组织");
    return service.organizationId;
  }
}

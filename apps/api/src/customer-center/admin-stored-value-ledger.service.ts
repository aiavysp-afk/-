import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import type {
  AdminStoredValueLedger,
  AdminStoredValueLedgerQuery,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

@Injectable()
export class AdminStoredValueLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async get(
    principal: AuthPrincipal,
    organizationId: string,
    query: AdminStoredValueLedgerQuery,
  ): Promise<AdminStoredValueLedger> {
    if (
      !this.access.hasPermission(principal, "finance.request", organizationId)
    )
      this.access.assertPermission(
        principal,
        "finance.approve",
        organizationId,
      );
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
      throw new BadRequestException("账本查询条数须为 1 至 100");
    const scope = {
      organizationId,
      ...(query.customerId ? { customerId: query.customerId } : {}),
    };
    const customer = { select: { id: true, displayName: true } } as const;
    const [balance, success, accounts, recharges, transactions] =
      await Promise.all([
        this.prisma.storedValueAccount.aggregate({
          where: scope,
          _sum: { balanceFen: true },
        }),
        this.prisma.storedValueRecharge.aggregate({
          where: { ...scope, status: "SUCCEEDED" },
          _sum: { amountFen: true },
          _count: { _all: true },
        }),
        this.prisma.storedValueAccount.findMany({
          where: scope,
          select: { id: true, customer, balanceFen: true, updatedAt: true },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        }),
        this.prisma.storedValueRecharge.findMany({
          where: scope,
          select: {
            id: true,
            accountId: true,
            customer,
            amountFen: true,
            status: true,
            merchantPaymentNo: true,
            providerTransactionId: true,
            prepayState: true,
            prepayFailureCode: true,
            createdAt: true,
            succeededAt: true,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        }),
        this.prisma.storedValueTransaction.findMany({
          where: { account: scope },
          select: {
            id: true,
            accountId: true,
            account: { select: { customer } },
            type: true,
            changeFen: true,
            balanceAfterFen: true,
            description: true,
            occurredAt: true,
            rechargeId: true,
            rewardId: true,
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        }),
      ]);
    const identity = (value: { id: string; displayName: string }) => ({
      userId: value.id,
      displayName: value.displayName,
    });
    return {
      organizationId,
      generatedAt: new Date().toISOString(),
      limit: query.limit,
      summary: {
        balanceFen: this.money(balance._sum.balanceFen ?? 0n),
        successfulRechargeFen: this.money(success._sum.amountFen ?? 0n),
        successfulRechargeCount: success._count._all,
      },
      accounts: accounts.slice(0, query.limit).map((row) => ({
        id: row.id,
        customer: identity(row.customer),
        balanceFen: this.money(row.balanceFen),
        updatedAt: row.updatedAt.toISOString(),
      })),
      recharges: recharges.slice(0, query.limit).map((row) => ({
        id: row.id,
        accountId: row.accountId,
        customer: identity(row.customer),
        amountFen: this.money(row.amountFen),
        status: row.status,
        merchantPaymentNo: row.merchantPaymentNo,
        providerTransactionId: row.providerTransactionId,
        prepayState: row.prepayState,
        prepayFailureCode: row.prepayFailureCode,
        createdAt: row.createdAt.toISOString(),
        succeededAt: row.succeededAt?.toISOString() ?? null,
      })),
      transactions: transactions.slice(0, query.limit).map((row) => ({
        id: row.id,
        accountId: row.accountId,
        customer: identity(row.account.customer),
        type: row.type,
        changeFen: this.money(row.changeFen, true),
        balanceAfterFen: this.money(row.balanceAfterFen),
        description: row.description,
        occurredAt: row.occurredAt.toISOString(),
        rechargeId: row.rechargeId,
        rewardId: row.rewardId,
      })),
      hasMore: {
        accounts: accounts.length > query.limit,
        recharges: recharges.length > query.limit,
        transactions: transactions.length > query.limit,
      },
    };
  }

  private money(value: bigint, signed = false) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || (!signed && amount < 0))
      throw new InternalServerErrorException("账本金额超出安全序列化范围");
    return amount;
  }
}

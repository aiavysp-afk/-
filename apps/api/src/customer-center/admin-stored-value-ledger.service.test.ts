import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import { AdminStoredValueLedgerSchema } from "@zydj/contracts";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminStoredValueLedgerService } from "./admin-stored-value-ledger.service.js";
import { AdminCustomerCenterController } from "./customer-center.controller.js";

const occurredAt = new Date("2026-10-10T01:00:00Z");
const customer = {
  id: "customer-1",
  displayName: "客户",
  phoneEncrypted: "private-phone",
  authIdentities: [{ openId: "private-openid" }],
};
function principal(
  role: UserRole = "FINANCE_REQUESTER",
  organizationId = "org-1",
): AuthPrincipal {
  return {
    userId: "staff-1",
    sessionId: "session",
    displayName: "staff",
    memberships: [{ organizationId, role }],
    mfaVerifiedUntil: new Date(Date.now() + 60000),
  };
}
function setup() {
  const account = {
    id: "account-1",
    customer,
    balanceFen: 37600n,
    updatedAt: occurredAt,
  };
  const recharge = {
    id: "recharge-1",
    accountId: account.id,
    customer,
    amountFen: 28800n,
    status: "SUCCEEDED",
    merchantPaymentNo: "SVR001",
    providerTransactionId: "wx-txn-1",
    prepayState: "READY",
    prepayFailureCode: null,
    createdAt: occurredAt,
    succeededAt: occurredAt,
    providerReference: "private-prepay-token",
  };
  const transaction = {
    id: "transaction-1",
    accountId: account.id,
    account: { customer },
    type: "RECHARGE",
    changeFen: 28800n,
    balanceAfterFen: 28800n,
    description: "微信储值充值入账",
    occurredAt,
    rechargeId: recharge.id,
    rewardId: null,
  };
  const prisma = {
    storedValueAccount: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { balanceFen: 37600n } }),
      findMany: vi
        .fn()
        .mockResolvedValue([account, { ...account, id: "account-2" }]),
    },
    storedValueRecharge: {
      aggregate: vi
        .fn()
        .mockResolvedValue({
          _sum: { amountFen: 28800n },
          _count: { _all: 1 },
        }),
      findMany: vi
        .fn()
        .mockResolvedValue([recharge, { ...recharge, id: "recharge-2" }]),
    },
    storedValueTransaction: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          transaction,
          {
            ...transaction,
            id: "reward",
            type: "FIRST_RECHARGE_REWARD",
            changeFen: 8800n,
            balanceAfterFen: 37600n,
            rechargeId: null,
            rewardId: "reward-1",
          },
        ]),
    },
  };
  const access = new AccessControlService({ get: () => "production" } as never);
  return {
    prisma,
    service: new AdminStoredValueLedgerService(prisma as never, access),
    transaction,
  };
}

describe("organization stored-value ledger", () => {
  it("reads scoped real balances, recharge evidence and reward records with bounded lists", async () => {
    const { service, prisma } = setup();
    const result = AdminStoredValueLedgerSchema.parse(
      await service.get(principal(), "org-1", { limit: 1 }),
    );
    expect(result.summary).toEqual({
      balanceFen: 37600,
      successfulRechargeFen: 28800,
      successfulRechargeCount: 1,
    });
    expect(result.accounts).toEqual([
      {
        id: "account-1",
        customer: { userId: "customer-1", displayName: "客户" },
        balanceFen: 37600,
        updatedAt: occurredAt.toISOString(),
      },
    ]);
    expect(result.recharges[0]).toMatchObject({
      status: "SUCCEEDED",
      providerTransactionId: "wx-txn-1",
      amountFen: 28800,
    });
    expect(result.transactions[0]).toMatchObject({
      rechargeId: "recharge-1",
      rewardId: null,
      changeFen: 28800,
    });
    expect(result.hasMore).toEqual({
      accounts: true,
      recharges: true,
      transactions: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-phone|private-openid|private-prepay-token|phoneEncrypted|authIdentities|providerReference/,
    );
    for (const table of [
      prisma.storedValueAccount,
      prisma.storedValueRecharge,
    ]) {
      expect(table.aggregate.mock.calls[0]?.[0].where).toMatchObject({
        organizationId: "org-1",
      });
      expect(table.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { organizationId: "org-1" },
        take: 2,
      });
    }
    expect(
      prisma.storedValueTransaction.findMany.mock.calls[0]?.[0],
    ).toMatchObject({
      where: { account: { organizationId: "org-1" } },
      take: 2,
    });
    const full = await service.get(principal(), "org-1", { limit: 50 });
    expect(full.transactions[1]).toMatchObject({
      type: "FIRST_RECHARGE_REWARD",
      rewardId: "reward-1",
      changeFen: 8800,
    });
  });

  it("applies the optional customer filter to every aggregate and list", async () => {
    const { service, prisma } = setup();
    await service.get(principal(), "org-1", {
      limit: 50,
      customerId: "customer-1",
    });
    for (const table of [
      prisma.storedValueAccount,
      prisma.storedValueRecharge,
    ]) {
      expect(table.aggregate.mock.calls[0]?.[0].where).toMatchObject({
        organizationId: "org-1",
        customerId: "customer-1",
      });
      expect(table.findMany.mock.calls[0]?.[0].where).toEqual({
        organizationId: "org-1",
        customerId: "customer-1",
      });
    }
    expect(
      prisma.storedValueTransaction.findMany.mock.calls[0]?.[0].where,
    ).toEqual({
      account: { organizationId: "org-1", customerId: "customer-1" },
    });
  });

  it.each(["ADMIN", "FINANCE_REQUESTER", "FINANCE_APPROVER"] as UserRole[])(
    "permits %s only within its finance organization",
    async (role) => {
      const { service, prisma } = setup();
      await expect(
        service.get(principal(role), "org-1", { limit: 50 }),
      ).resolves.toMatchObject({ organizationId: "org-1" });
      await expect(
        service.get(principal(role), "other-org", { limit: 50 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.storedValueAccount.aggregate).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "CUSTOMER",
    "THERAPIST",
    "OPERATOR",
    "DISPATCHER",
    "SAFETY_DUTY",
  ] as UserRole[])(
    "does not grant %s access to other customers' wallets",
    async (role) => {
      const { service, prisma } = setup();
      await expect(
        service.get(principal(role), "org-1", { limit: 50 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.storedValueAccount.aggregate).not.toHaveBeenCalled();
      expect(prisma.storedValueTransaction.findMany).not.toHaveBeenCalled();
    },
  );

  it("requires valid staff MFA and rejects an excessive limit before database access", async () => {
    const { service, prisma } = setup();
    await expect(
      service.get({ ...principal(), mfaVerifiedUntil: new Date(0) }, "org-1", {
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.get(principal(), "org-1", { limit: 101 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.storedValueAccount.aggregate).not.toHaveBeenCalled();
  });

  it("preserves signed ledger changes and refuses unsafe serialized balances", async () => {
    const { service, prisma, transaction } = setup();
    prisma.storedValueTransaction.findMany.mockResolvedValue([
      { ...transaction, type: "ADJUSTMENT", changeFen: -100n },
    ]);
    expect(
      (await service.get(principal(), "org-1", { limit: 50 })).transactions[0]
        ?.changeFen,
    ).toBe(-100);
    prisma.storedValueAccount.aggregate.mockResolvedValue({
      _sum: { balanceFen: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    });
    await expect(
      service.get(principal(), "org-1", { limit: 50 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("validates controller filters before invoking the read-only service", async () => {
    const ledger = {
      get: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
    };
    const controller = new AdminCustomerCenterController(
      {} as never,
      ledger as never,
    );
    const staff = principal();
    await expect(
      controller.ledger(staff, "org-1", { limit: "101" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.get).not.toHaveBeenCalled();
    await expect(controller.ledger(staff, "org-1", {})).resolves.toEqual({
      data: { organizationId: "org-1" },
    });
    expect(ledger.get).toHaveBeenCalledWith(staff, "org-1", { limit: 50 });
  });
});

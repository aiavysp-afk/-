import {
  ConflictException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { StoredValueRechargeCreateSchema } from "@zydj/contracts";
import {
  StoredValueRechargeStatus,
  WechatPrepayState,
  type StoredValueRecharge,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoredValueRechargesService } from "./stored-value-recharges.service.js";
import type { WechatTransaction } from "./wechat-pay.protocol.js";

const transaction: WechatTransaction = {
  appid: "app-1",
  mchid: "merchant-1",
  out_trade_no: "SVR123",
  transaction_id: "wx-recharge-1",
  trade_type: "JSAPI",
  trade_state: "SUCCESS",
  success_time: "2026-10-09T12:00:00Z",
  amount: { total: 59_900, currency: "CNY" },
};

const recharge: StoredValueRecharge = {
  id: "recharge-1",
  organizationId: "org-1",
  customerId: "customer-1",
  accountId: "account-1",
  amountFen: 59_900n,
  status: StoredValueRechargeStatus.PENDING,
  merchantPaymentNo: "SVR123",
  providerReference: "prepay-1",
  providerTransactionId: null,
  prepayState: WechatPrepayState.READY,
  prepayRequestedAt: new Date("2026-10-09T11:59:00Z"),
  prepayReadyAt: new Date("2026-10-09T11:59:01Z"),
  prepayFailureCode: null,
  idempotencyKey: "key-1",
  requestFingerprint: "fingerprint",
  expiresAt: new Date("2026-10-09T12:14:00Z"),
  succeededAt: null,
  createdAt: new Date("2026-10-09T11:59:00Z"),
  updatedAt: new Date("2026-10-09T11:59:00Z"),
};

function setup(current: StoredValueRecharge = recharge) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    storedValueRecharge: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue({
        ...current,
        status: StoredValueRechargeStatus.SUCCEEDED,
        succeededAt: new Date(transaction.success_time!),
      }),
      create: vi.fn().mockResolvedValue({
        ...current,
        id: "new-recharge",
        status: StoredValueRechargeStatus.PENDING,
      }),
    },
    storedValueAccount: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "account-1",
        balanceFen: 10_000n,
        customerId: "customer-1",
        organizationId: "org-1",
      }),
      upsert: vi.fn().mockResolvedValue({ id: "account-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    storedValueTransaction: { create: vi.fn().mockResolvedValue({}) },
    storedValueFirstRechargeReward: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    storedValueRecharge: {
      findUnique: vi.fn().mockResolvedValue(current),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({
        ...current,
        id: "new-recharge",
        status: StoredValueRechargeStatus.PENDING,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    storedValueFirstRechargeReward: {
      findUnique: tx.storedValueFirstRechargeReward.findUnique,
    },
    storedValueAccount: {
      findUnique: vi.fn().mockResolvedValue({ id: "account-1" }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ id: "org-1" }) },
    service: { findFirst: vi.fn().mockResolvedValue({ id: "service-1" }) },
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const config = {
    get: vi.fn<(key: string) => string>((key: string) =>
      key === "STORED_VALUE_RECHARGE_ENABLED" ? "true" : "中原到家",
    ),
  };
  const client = {
    verifierConfig: vi
      .fn()
      .mockReturnValue({ appId: "app-1", merchantId: "merchant-1" }),
    assertPrepayEnabled: vi.fn(),
    assertRecoveryEnabled: vi.fn(),
    queryTransaction: vi.fn(),
    closeTransaction: vi.fn(),
    submitRefund: vi.fn(),
    prepay: vi.fn().mockResolvedValue("new-prepay"),
    paymentParameters: vi.fn().mockReturnValue({}),
  };
  return {
    service: new StoredValueRechargesService(
      prisma as never,
      config as never,
      { buildWechatJsapiRequest: vi.fn().mockReturnValue({}) } as never,
      client as never,
      { payerOpenId: vi.fn().mockResolvedValue("openid-1") } as never,
    ),
    prisma,
    tx,
    config,
    client,
  };
}

function recoverySetup(current: StoredValueRecharge = { ...recharge }) {
  const fixture = setup(current);
  fixture.config.get.mockImplementation((key) => {
    if (key === "PAYMENT_PROVIDER") return "wechat";
    if (
      key === "WECHAT_PAY_RECOVERY_ENABLED" ||
      key === "STORED_VALUE_RECHARGE_ENABLED"
    )
      return "true";
    return "中原到家";
  });
  fixture.client.queryTransaction.mockResolvedValue(transaction);
  return fixture;
}

function expectNoRecoveryWrites(fixture: ReturnType<typeof setup>) {
  expect(fixture.tx.storedValueRecharge.update).not.toHaveBeenCalled();
  expect(fixture.tx.storedValueAccount.update).not.toHaveBeenCalled();
  expect(fixture.tx.storedValueTransaction.create).not.toHaveBeenCalled();
  expect(
    fixture.tx.storedValueFirstRechargeReward.create,
  ).not.toHaveBeenCalled();
  expect(
    fixture.tx.storedValueFirstRechargeReward.update,
  ).not.toHaveBeenCalled();
  expect(fixture.tx.auditLog.create).not.toHaveBeenCalled();
  expect(fixture.tx.outboxEvent.create).not.toHaveBeenCalled();
  expect(fixture.client.prepay).not.toHaveBeenCalled();
  expect(fixture.client.closeTransaction).not.toHaveBeenCalled();
  expect(fixture.client.submitRefund).not.toHaveBeenCalled();
}

describe("StoredValueRechargesService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:01:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("credits the wallet once after a verified WeChat success", async () => {
    const { service, tx } = setup();
    await expect(
      service.applyIfPresent(transaction, "NOTIFICATION"),
    ).resolves.toBe(true);
    expect(tx.storedValueAccount.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: { balanceFen: 69_900n },
    });
    expect(tx.storedValueTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rechargeId: "recharge-1",
        changeFen: 59_900n,
        balanceAfterFen: 69_900n,
      }),
    });
    expect(tx.storedValueFirstRechargeReward.create).not.toHaveBeenCalled();
  });

  it("does not credit the wallet twice for a duplicate callback", async () => {
    const { service, tx } = setup({
      ...recharge,
      status: StoredValueRechargeStatus.SUCCEEDED,
      providerTransactionId: "wx-recharge-1",
    });
    await expect(
      service.applyIfPresent(transaction, "NOTIFICATION"),
    ).resolves.toBe(true);
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
    expect(tx.storedValueTransaction.create).not.toHaveBeenCalled();
  });

  it("refuses to create a charge while the dedicated gate is closed", async () => {
    const { service, config, prisma } = setup();
    config.get.mockReturnValue("false");
    await expect(
      service.createIntent(
        {
          sessionId: "session-1",
          userId: "customer-1",
          displayName: "客户",
          memberships: [],
        },
        { amountFen: 59_900 },
        "recharge-key-1",
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.storedValueRecharge.findUnique).not.toHaveBeenCalled();
  });

  it("accepts the new 288 yuan plan and rejects arbitrary amounts", () => {
    expect(
      StoredValueRechargeCreateSchema.safeParse({ amountFen: 28_800 }).success,
    ).toBe(true);
    expect(
      StoredValueRechargeCreateSchema.safeParse({ amountFen: 288 }).success,
    ).toBe(false);
  });

  it("unlocks the 88 yuan reward after first successful 288 without automatically crediting it", async () => {
    const { service, tx } = setup({ ...recharge, amountFen: 28_800n });
    await service.applyIfPresent(
      { ...transaction, amount: { total: 28_800, currency: "CNY" } },
      "NOTIFICATION",
    );
    expect(tx.storedValueFirstRechargeReward.create).toHaveBeenCalledWith({
      data: {
        accountId: "account-1",
        rechargeId: "recharge-1",
        amountFen: 8_800n,
      },
    });
    expect(tx.storedValueAccount.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: { balanceFen: 38_800n },
    });
    expect(tx.storedValueTransaction.create).toHaveBeenCalledTimes(1);
  });

  it("does not unlock a first-recharge reward for a later 288 recharge", async () => {
    const { service, tx } = setup({ ...recharge, amountFen: 28_800n });
    tx.storedValueRecharge.findFirst.mockResolvedValue({
      ...recharge,
      id: "earlier-success-599",
      status: StoredValueRechargeStatus.SUCCEEDED,
      succeededAt: new Date("2026-10-09T11:59:30Z"),
    });
    await service.applyIfPresent(
      { ...transaction, amount: { total: 28_800, currency: "CNY" } },
      "NOTIFICATION",
    );
    expect(tx.storedValueFirstRechargeReward.create).not.toHaveBeenCalled();
  });

  const customer = {
    sessionId: "session-1",
    userId: "customer-1",
    displayName: "客户",
    memberships: [],
  };
  const eligibleReward = {
    id: "reward-1",
    accountId: "account-1",
    rechargeId: "recharge-1",
    amountFen: 8_800n,
    claimedAt: null as Date | null,
    recharge: {
      ...recharge,
      amountFen: 28_800n,
      status: StoredValueRechargeStatus.SUCCEEDED,
      succeededAt: new Date(transaction.success_time!),
    },
  };

  it("manually credits 88 once and replays a second claim without another balance change", async () => {
    const { service, tx } = setup();
    tx.storedValueAccount.findUniqueOrThrow.mockResolvedValue({
      id: "account-1",
      balanceFen: 28_800n,
      customerId: "customer-1",
      organizationId: "org-1",
    } as never);
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    tx.storedValueRecharge.findFirst.mockResolvedValue(eligibleReward.recharge);
    const first = await service.claimFirstRechargeReward(customer, "org-1");
    expect(first.balanceFen).toBe(37_600);
    expect(first.amountFen).toBe(8_800);
    expect(tx.storedValueTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rewardId: "reward-1",
        type: "FIRST_RECHARGE_REWARD",
        changeFen: 8_800n,
      }),
    });
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue({
      ...eligibleReward,
      claimedAt: new Date(first.claimedAt),
    } as never);
    tx.storedValueAccount.findUniqueOrThrow.mockResolvedValue({
      id: "account-1",
      balanceFen: 37_600n,
      customerId: "customer-1",
      organizationId: "org-1",
    } as never);
    const second = await service.claimFirstRechargeReward(customer, "org-1");
    expect(second).toEqual(first);
    expect(tx.storedValueAccount.update).toHaveBeenCalledTimes(1);
    expect(tx.storedValueTransaction.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconfirmed recharge reward without changing the wallet", async () => {
    const { service, tx } = setup();
    tx.storedValueAccount.findUniqueOrThrow.mockResolvedValue({
      id: "account-1",
      balanceFen: 0n,
      customerId: "customer-1",
      organizationId: "org-1",
    } as never);
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue({
      ...eligibleReward,
      recharge: {
        ...eligibleReward.recharge,
        status: StoredValueRechargeStatus.PENDING,
      },
    } as never);
    await expect(
      service.claimFirstRechargeReward(customer, "org-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
  });

  it("qualifies the earlier actual 288 even when another successful payment was already processed", async () => {
    const { service, tx } = setup({ ...recharge, amountFen: 28_800n });
    // The old callback-count rule rejected this customer; actual successful
    // time now makes this 288 payment first regardless of delivery order.
    tx.storedValueRecharge.count.mockResolvedValue(1);
    await service.applyIfPresent(
      { ...transaction, amount: { total: 28_800, currency: "CNY" } },
      "NOTIFICATION",
    );
    expect(tx.storedValueFirstRechargeReward.create).toHaveBeenCalledWith({
      data: {
        accountId: "account-1",
        rechargeId: "recharge-1",
        amountFen: 8_800n,
      },
    });
    expect(tx.storedValueRecharge.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: "account-1",
        status: StoredValueRechargeStatus.SUCCEEDED,
      },
      orderBy: [{ succeededAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("resolves an earlier pending payment before refusing an ineligible reward", async () => {
    const pending = {
      ...recharge,
      id: "earlier-599",
      merchantPaymentNo: "SVR456",
      createdAt: new Date("2026-10-09T11:58:00Z"),
    };
    const { service, prisma, tx, client } = setup();
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    prisma.storedValueRecharge.findMany.mockResolvedValue([pending] as never);
    prisma.storedValueRecharge.findUnique.mockResolvedValue(pending);
    tx.storedValueRecharge.findUniqueOrThrow.mockResolvedValue(pending);
    tx.storedValueRecharge.findFirst.mockResolvedValue({
      ...pending,
      status: StoredValueRechargeStatus.SUCCEEDED,
      succeededAt: new Date("2026-10-09T11:59:30Z"),
    });
    client.queryTransaction.mockResolvedValue({
      ...transaction,
      out_trade_no: "SVR456",
      transaction_id: "wx-earlier",
      success_time: "2026-10-09T11:59:30Z",
    });
    await expect(
      service.claimFirstRechargeReward(customer, "org-1"),
    ).rejects.toThrow("首次成功充值");
    expect(client.queryTransaction).toHaveBeenCalledWith("SVR456");
    expect(tx.storedValueTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RECHARGE",
        rechargeId: "earlier-599",
      }),
    });
    expect(
      tx.storedValueTransaction.create.mock.calls.some(
        ([args]) => args.data.type === "FIRST_RECHARGE_REWARD",
      ),
    ).toBe(false);
  });

  it("does not award or close an earlier NOTPAY recharge", async () => {
    const pending = {
      ...recharge,
      id: "earlier-pending",
      merchantPaymentNo: "SVR456",
    };
    const { service, prisma, tx, client } = setup();
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    prisma.storedValueRecharge.findMany.mockResolvedValue([pending] as never);
    client.queryTransaction.mockResolvedValue({
      appid: "app-1",
      mchid: "merchant-1",
      out_trade_no: "SVR456",
      trade_state: "NOTPAY",
    });
    await expect(
      service.claimFirstRechargeReward(customer, "org-1"),
    ).rejects.toThrow("确认中");
    expect(tx.storedValueRecharge.update).not.toHaveBeenCalled();
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
    expect(client.prepay).not.toHaveBeenCalled();
  });

  it("permits a reward only after a verified read-only CLOSED query resolves an earlier attempt", async () => {
    const pending = {
      ...recharge,
      id: "earlier-closed",
      merchantPaymentNo: "SVR456",
    };
    const { service, prisma, tx, client } = setup();
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    tx.storedValueRecharge.findFirst.mockResolvedValue(eligibleReward.recharge);
    tx.storedValueRecharge.findUniqueOrThrow.mockResolvedValue(pending);
    prisma.storedValueRecharge.findMany.mockResolvedValue([pending] as never);
    client.queryTransaction.mockResolvedValue({
      appid: "app-1",
      mchid: "merchant-1",
      out_trade_no: "SVR456",
      trade_state: "CLOSED",
    });
    const result = await service.claimFirstRechargeReward(customer, "org-1");
    expect(result.amountFen).toBe(8_800);
    expect(tx.storedValueRecharge.update).toHaveBeenCalledWith({
      where: { id: "earlier-closed" },
      data: {
        status: StoredValueRechargeStatus.CLOSED,
        prepayFailureCode: "QUERY_VERIFIED_CLOSED",
      },
    });
    expect(client.prepay).not.toHaveBeenCalled();
  });

  it("refuses wrong-merchant query evidence and leaves both wallet and pending recharge unchanged", async () => {
    const { service, prisma, tx, client } = setup();
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    prisma.storedValueRecharge.findMany.mockResolvedValue([
      { ...recharge, merchantPaymentNo: "SVR456" },
    ] as never);
    client.queryTransaction.mockResolvedValue({
      appid: "app-1",
      mchid: "wrong-merchant",
      out_trade_no: "SVR456",
      trade_state: "CLOSED",
    });
    await expect(
      service.claimFirstRechargeReward(customer, "org-1"),
    ).rejects.toThrow("确认中");
    expect(tx.storedValueRecharge.update).not.toHaveBeenCalled();
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
  });

  it("rechecks unresolved attempts in the final locked transaction", async () => {
    const { service, tx } = setup();
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    tx.storedValueRecharge.findFirst.mockResolvedValue(eligibleReward.recharge);
    tx.storedValueRecharge.count.mockResolvedValue(1);
    await expect(
      service.claimFirstRechargeReward(customer, "org-1"),
    ).rejects.toThrow("确认中");
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
  });

  it("rejects unsafe total balances before updating any funds", async () => {
    const { service, tx } = setup({ ...recharge, amountFen: 28_800n });
    tx.storedValueAccount.findUniqueOrThrow.mockResolvedValue({
      id: "account-1",
      customerId: "customer-1",
      organizationId: "org-1",
      balanceFen: BigInt(Number.MAX_SAFE_INTEGER),
    });
    await expect(
      service.applyIfPresent(
        { ...transaction, amount: { total: 28_800, currency: "CNY" } },
        "NOTIFICATION",
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(tx.storedValueAccount.update).not.toHaveBeenCalled();
    expect(tx.storedValueRecharge.update).not.toHaveBeenCalled();
  });

  it("stamps createdAt after obtaining the wallet lock for new intents", async () => {
    const { service, prisma, tx } = setup();
    prisma.storedValueRecharge.findUnique.mockResolvedValue(null as never);
    tx.$queryRaw.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-09T12:01:01Z"));
      return [];
    });
    await service.createIntent(
      customer,
      { amountFen: 28_800, organizationId: "org-1" },
      "new-valid-idempotency-key",
    );
    expect(tx.storedValueRecharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdAt: new Date("2026-10-09T12:01:01Z"),
      }),
    });
  });

  it("prepay uncertainty cannot downgrade a concurrently successful recharge", async () => {
    const { service, prisma, client } = setup();
    prisma.storedValueRecharge.findUnique.mockResolvedValue(null as never);
    client.prepay.mockRejectedValue(new Error("timeout"));
    await expect(
      service.createIntent(
        customer,
        { amountFen: 28_800, organizationId: "org-1" },
        "new-valid-idempotency-key",
      ),
    ).rejects.toThrow("未确认");
    expect(prisma.storedValueRecharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              StoredValueRechargeStatus.PENDING,
              StoredValueRechargeStatus.UNKNOWN,
            ],
          },
        }),
      }),
    );
  });

  it("rebinds an unclaimed reward when an earlier actual 288 callback arrives", async () => {
    const earlier = { ...recharge, id: "earlier-288", amountFen: 28_800n };
    const { service, tx } = setup(earlier);
    tx.storedValueFirstRechargeReward.findUnique.mockResolvedValue(
      eligibleReward as never,
    );
    await service.applyIfPresent(
      { ...transaction, amount: { total: 28_800, currency: "CNY" } },
      "NOTIFICATION",
    );
    expect(tx.storedValueFirstRechargeReward.update).toHaveBeenCalledWith({
      where: { id: "reward-1" },
      data: { rechargeId: "earlier-288" },
    });
    expect(tx.storedValueFirstRechargeReward.create).not.toHaveBeenCalled();
  });

  it.each([
    ["mock", "true"],
    ["wechat", "false"],
  ])(
    "does not read or query originals when provider=%s and recovery gate=%s",
    async (provider, gate) => {
      const f = recoverySetup();
      f.config.get.mockImplementation((key) =>
        key === "PAYMENT_PROVIDER" ? provider : gate,
      );
      expect(await f.service.recoverExisting(recharge.id)).toBe(false);
      expect(f.prisma.storedValueRecharge.findUnique).not.toHaveBeenCalled();
      expect(f.client.assertRecoveryEnabled).not.toHaveBeenCalled();
      expect(f.client.queryTransaction).not.toHaveBeenCalled();
      expectNoRecoveryWrites(f);
    },
  );

  it("settles only the stored original after a verified successful recovery query", async () => {
    const f = recoverySetup();
    await expect(f.service.recoverExisting(recharge.id)).resolves.toBe(true);
    expect(f.client.assertRecoveryEnabled).toHaveBeenCalledOnce();
    expect(f.client.queryTransaction).toHaveBeenCalledExactlyOnceWith("SVR123");
    expect(f.tx.storedValueAccount.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: { balanceFen: 69_900n },
    });
    expect(f.tx.storedValueTransaction.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        rechargeId: recharge.id,
        changeFen: 59_900n,
        balanceAfterFen: 69_900n,
      }),
    });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: { source: "QUERY", amountFen: 59_900 },
      }),
    });
    expect(f.client.prepay).not.toHaveBeenCalled();
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.client.submitRefund).not.toHaveBeenCalled();
    expect(f.tx.storedValueFirstRechargeReward.update).not.toHaveBeenCalled();
  });

  it.each([
    StoredValueRechargeStatus.SUCCEEDED,
    StoredValueRechargeStatus.CLOSED,
  ])("does not query an original already locally %s", async (status) => {
    const f = recoverySetup({
      ...recharge,
      status,
      providerTransactionId:
        status === "SUCCEEDED" ? transaction.transaction_id! : null,
    });
    expect(await f.service.recoverExisting(recharge.id)).toBe(false);
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
    expectNoRecoveryWrites(f);
  });

  it("does not query a missing original", async () => {
    const f = recoverySetup();
    f.prisma.storedValueRecharge.findUnique.mockResolvedValue(null as never);
    expect(await f.service.recoverExisting("missing-original")).toBe(false);
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
    expectNoRecoveryWrites(f);
  });

  it.each(["NOTPAY", "CLOSED"])(
    "leaves all funds and original status unchanged for a verified %s query",
    async (trade_state) => {
      const f = recoverySetup();
      f.client.queryTransaction.mockResolvedValue({
        appid: "app-1",
        mchid: "merchant-1",
        out_trade_no: "SVR123",
        trade_state,
      });
      expect(await f.service.recoverExisting(recharge.id)).toBe(false);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expectNoRecoveryWrites(f);
    },
  );

  it.each([
    ["wrong app", { ...transaction, appid: "other-app" }],
    ["wrong merchant", { ...transaction, mchid: "other-merchant" }],
    ["wrong original number", { ...transaction, out_trade_no: "SVR_OTHER" }],
    ["wrong amount", { ...transaction, amount: { total: 1, currency: "CNY" } }],
    [
      "missing provider transaction",
      { ...transaction, transaction_id: undefined },
    ],
  ])(
    "rejects %s recovery evidence without writing any funds",
    async (_reason, response) => {
      const f = recoverySetup();
      f.client.queryTransaction.mockResolvedValue(response);
      await expect(f.service.recoverExisting(recharge.id)).rejects.toThrow();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expectNoRecoveryWrites(f);
    },
  );

  it("does not write funds after a network or response-signature failure", async () => {
    const f = recoverySetup();
    f.client.queryTransaction.mockRejectedValue(
      new Error("query evidence unavailable"),
    );
    await expect(f.service.recoverExisting(recharge.id)).rejects.toThrow(
      "query evidence unavailable",
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expectNoRecoveryWrites(f);
  });

  it("rechecks success under the transaction lock when recovery and callback race, then skips further scans", async () => {
    const current = { ...recharge };
    const f = recoverySetup(current);
    f.prisma.storedValueRecharge.findUnique.mockImplementation(async () => ({
      ...current,
    }));
    f.tx.storedValueRecharge.findUniqueOrThrow.mockImplementation(async () => ({
      ...current,
    }));
    f.tx.storedValueRecharge.update.mockImplementation(
      async ({ data }: any) => {
        Object.assign(current, data);
        return { ...current };
      },
    );
    let transactionQueue: Promise<unknown> = Promise.resolve();
    f.prisma.$transaction.mockImplementation((operation) => {
      const result = transactionQueue.then(() => operation(f.tx));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    await Promise.all([
      f.service.recoverExisting(current.id),
      f.service.applyIfPresent(transaction, "NOTIFICATION"),
    ]);
    expect(current.status).toBe(StoredValueRechargeStatus.SUCCEEDED);
    expect(f.tx.storedValueRecharge.update).toHaveBeenCalledOnce();
    expect(f.tx.storedValueAccount.update).toHaveBeenCalledOnce();
    expect(f.tx.storedValueTransaction.create).toHaveBeenCalledOnce();
    expect(f.tx.auditLog.create).toHaveBeenCalledOnce();
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(await f.service.recoverExisting(current.id)).toBe(false);
    expect(f.client.queryTransaction).toHaveBeenCalledOnce();
    await f.service.applyIfPresent(transaction, "NOTIFICATION");
    expect(f.tx.storedValueTransaction.create).toHaveBeenCalledOnce();
    expect(f.tx.storedValueAccount.update).toHaveBeenCalledOnce();
  });
});

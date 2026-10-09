import { ServiceUnavailableException } from "@nestjs/common";
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
    },
    storedValueAccount: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "account-1", balanceFen: 10_000n }),
      update: vi.fn().mockResolvedValue({}),
    },
    storedValueTransaction: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    storedValueRecharge: {
      findUnique: vi.fn().mockResolvedValue(recharge),
    },
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
  };
  return {
    service: new StoredValueRechargesService(
      prisma as never,
      config as never,
      {} as never,
      client as never,
      {} as never,
    ),
    prisma,
    tx,
    config,
  };
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
});

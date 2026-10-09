import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function fixture({
  status = "CLAIMABLE",
  claimFails = false,
  gate,
} = {}) {
  const calls = [],
    toasts = [],
    modals = [];
  let definition;
  const wallet = {
    balanceFen: 37_600,
    cards: [],
    recharge: {
      enabled: true,
      reason: "微信充值",
      plans: [28_800, 59_900, 88_800, 119_800, 288_800].map((amountFen) => ({
        amountFen,
        label: `${amountFen / 100}元`,
      })),
      firstRechargeReward: {
        enabled: false,
        status: "CLAIMED",
        reason: "已领取",
        amountFen: 8800,
        claimedAt: "2026-10-09T10:00:00Z",
      },
    },
    withdrawal: {
      reason: "未开放",
      enabled: false,
      minimumFen: 100000,
      stepFen: 100000,
      reviewRequired: true,
    },
    checkIn: { reason: "未开放" },
  };
  const api = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.endsWith("first-recharge-reward/claim")) {
      assert.equal(method, "POST");
      assert.deepEqual(Object.keys(body), ["organizationId"]);
      if (gate) await gate;
      if (claimFails) throw new Error("支付结果确认中");
      return { amountFen: 8800, balanceFen: 37600 };
    }
    if (path.startsWith("/customer-center/wallet"))
      return structuredClone(wallet);
    throw new Error(`Unexpected API ${path}`);
  };
  vm.runInNewContext(
    await readFile(
      new URL("../apps/miniapp/pages/stored-value/index.js", import.meta.url),
      "utf8",
    ),
    {
      exports: {},
      Error,
      Page(input) {
        definition = input;
      },
      wx: {
        showToast(input) {
          toasts.push(input);
        },
        showModal(input) {
          modals.push(input);
          input.success({ confirm: false });
        },
      },
      require(name) {
        if (name === "../../utils/api")
          return {
            api,
            money: (fen) => (fen / 100).toFixed(2),
            newKey: () => "fixture-key",
            shanghaiTime: () => "fixture",
          };
        if (name === "../../utils/customer-center")
          return {
            customerCenterPath: (path) => path,
            getCustomerCenterOrganizationId: () => "org-fixture",
          };
        if (name === "../../utils/auth")
          return { requireVerifiedCustomerAccess: () => true };
        throw new Error(`Unexpected dependency ${name}`);
      },
    },
  );
  const page = {
    ...definition,
    data: {
      ...structuredClone(definition.data),
      firstRechargeStatus: status,
      firstRechargeClaimable: status === "CLAIMABLE",
      balance: "288.00",
    },
    setData(values) {
      Object.assign(this.data, values);
    },
  };
  return { page, calls, toasts, modals };
}

test("reward claim is manual, uses owned organization only and reloads server balance", async () => {
  const f = await fixture();
  assert.equal(f.calls.length, 0);
  await f.page.claimFirstRechargeReward();
  assert.equal(f.calls.length, 2);
  assert.equal(f.page.data.balance, "376.00");
  assert.equal(f.page.data.firstRechargeClaimable, false);
  await f.page.claimFirstRechargeReward();
  assert.equal(f.calls.length, 2);
});

test("double tap and uncertain claim never create local reward balance", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ gate, claimFails: true });
  const pending = f.page.claimFirstRechargeReward();
  await f.page.claimFirstRechargeReward();
  assert.equal(f.calls.length, 1);
  assert.equal(f.page.data.balance, "288.00");
  release();
  await pending;
  assert.equal(f.page.data.balance, "288.00");
  assert.equal(f.page.data.firstRechargeBusy, false);
  assert.match(f.toasts[0].title, /确认中/);
});

test("locked entitlement cannot be claimed and the shortcut chooses 288 without charging", async () => {
  const f = await fixture({ status: "LOCKED" });
  await f.page.claimFirstRechargeReward();
  assert.equal(f.calls.length, 0);
  await f.page.load();
  f.page.rechargeFirst();
  assert.equal(
    f.page.data.rechargePlans[f.page.data.selectedRecharge].amountFen,
    28800,
  );
  assert.equal(f.page.data.rechargeOpen, true);
  const prior = f.calls.length;
  await f.page.confirmRecharge();
  assert.equal(f.calls.length, prior);
  assert.match(f.modals[0].title, /288\.00/);
});

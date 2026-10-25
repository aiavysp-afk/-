import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function fixture({ eligible = true, authenticated = true } = {}) {
  const calls = [];
  let page;
  let claimed = false;
  vm.runInNewContext(readFileSync(new URL("../apps/miniapp/pages/coupons/index.js", import.meta.url), "utf8"), {
    exports: {},
    Page(value) { page = value; },
    wx: { showToast() {}, switchTab() {} },
    require(path) {
      if (path.endsWith("/api")) return { money: value => String(value / 100), async api(path, method = "GET") {
        calls.push({path,method});
        if (path === "/customer-center/newcomer-coupons") {
          if (method === "POST") claimed = true;
          return { claimed, eligible: eligible && !claimed, reason: claimed ? "已领取" : "可领取" };
        }
        return [];
      }};
      if (path.endsWith("/customer-center")) return { customerCenterPath: path => path };
      if (path.endsWith("/auth")) return { requireVerifiedCustomerAccess: () => authenticated };
      throw new Error("Unexpected module");
    },
  });
  page.setData = patch => Object.assign(page.data, patch);
  return {page,calls};
}
test("entering coupon wallet reads eligibility without granting assets; manual double tap grants once", async () => {
  const {page,calls} = fixture();
  await page.onShow();
  assert.equal(calls.filter(c => c.method === "POST").length,0);
  assert.equal(page.data.newcomer.eligible,true);
  await Promise.all([page.claimNewcomer(),page.claimNewcomer()]);
  assert.equal(calls.filter(c => c.method === "POST").length,1);
  assert.equal(page.data.newcomer.claimed,true);
  assert.equal(page.data.newcomerBusy,false);
  await page.claimNewcomer();
  assert.equal(calls.filter(c => c.method === "POST").length,1);
});
test("visitors and ineligible customers cannot issue coupon claims", async () => {
  const visitor=fixture({authenticated:false});
  await visitor.page.onShow();
  await visitor.page.claimNewcomer();
  assert.equal(visitor.calls.length,0);
  const customer=fixture({eligible:false});
  await customer.page.onShow();
  await customer.page.claimNewcomer();
  assert.equal(customer.calls.filter(c=>c.method==='POST').length,0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const customerPages = [
  "coupons",
  "stored-value",
  "settings",
  "account-security",
  "addresses",
  "customer-records",
];

test("customer center pages and the five-item tab bar are registered", () => {
  const app = JSON.parse(read("apps/miniapp/app.json"));
  assert.deepEqual(
    app.tabBar.list.map((item) => [item.pagePath, item.text]),
    [
      ["pages/home/index", "首页"],
      ["pages/discover/index", "发现"],
      ["pages/services/index", "下单"],
      ["pages/messages/index", "消息"],
      ["pages/profile/index", "我的"],
    ],
  );
  for (const page of [...customerPages, "discover", "messages"]) {
    assert.ok(
      app.pages.includes(`pages/${page}/index`),
      `${page} is registered`,
    );
    for (const extension of ["ts", "js", "wxml", "wxss", "json"])
      assert.doesNotThrow(() =>
        read(`apps/miniapp/pages/${page}/index.${extension}`),
      );
  }
});

test("personal center reads synchronized data without inventing money", () => {
  const profile = read("apps/miniapp/pages/profile/index.ts");
  const storedValue = read("apps/miniapp/pages/stored-value/index.ts");
  const coupons = read("apps/miniapp/pages/coupons/index.ts");

  assert.match(profile, /loadCustomerCenterOverview/);
  assert.match(profile, /maskedBalance:\s*"\*\*\*\*"/);
  assert.match(storedValue, /customer-center\/wallet/);
  assert.match(storedValue, /wallet\.recharge\.reason/);
  assert.match(storedValue, /wx\.requestPayment/);
  assert.match(storedValue, /reconciled\.status === "SUCCEEDED"/);
  assert.match(storedValue, /balance: money\(wallet\.balanceFen\)/);
  assert.doesNotMatch(storedValue, /balance:\s*"0\.00"/);
  assert.match(coupons, /customer-center\/coupons/);
});

test("address book always obtains GCJ-02 coordinates before persistence", () => {
  const addresses = read("apps/miniapp/pages/addresses/index.ts");
  const booking = read("apps/miniapp/pages/booking/index.ts");
  assert.match(addresses, /getGcj02Location/);
  assert.match(addresses, /\/locations\/address-geocodes/);
  assert.match(addresses, /coordinateSystem:\s*"GCJ-02"/);
  assert.doesNotMatch(addresses, /latitude:\s*0[,\n]/);
  assert.doesNotMatch(addresses, /longitude:\s*0[,\n]/);
  assert.match(booking, /customer-center\/addresses/);
  assert.match(
    booking,
    /savedAddresses\.find\(\s*\(item\) => item\.isDefault\)/,
  );
  assert.match(booking, /\/locations\/address-verifications/);
});

test("account deletion is a risk-confirmed soft request", () => {
  const security = read("apps/miniapp/pages/account-security/index.ts");
  const securityView = read("apps/miniapp/pages/account-security/index.wxml");
  assert.match(security, /customer-center\/account-deletion/);
  assert.match(security, /acknowledgedRisk:\s*true/);
  assert.match(security, /不会立即硬删除数据/);
  assert.match(securityView, /注销完成后不可恢复/);
});

test("orders apply every personal-center status filter", () => {
  const orders = read("apps/miniapp/pages/orders/index.ts");
  for (const filter of [
    "PENDING_PAYMENT",
    "IN_PROGRESS",
    "PENDING_REVIEW",
    "CANCELLED",
  ])
    assert.match(orders, new RegExp(`orderFilter === "${filter}"`));
  assert.match(
    orders,
    /order\.status === "COMPLETED" && order\.reviewStatus === null/,
  );
});

test("admin and API expose customer-center configuration and monitoring", () => {
  const admin = read("apps/admin-web/src/customer-center-workspace.tsx");
  const adminPaths = read("apps/admin-web/src/customer-center.ts");
  const controller = read(
    "apps/api/src/customer-center/customer-center.controller.ts",
  );
  const access = read("apps/api/src/auth/access-control.service.ts");
  assert.match(admin, /customerCenterPaths/);
  assert.match(adminPaths, /\/customer-center`/);
  assert.match(adminPaths, /config:\s*`\$\{prefix\}\/config`/);
  assert.match(adminPaths, /summary:\s*`\$\{prefix\}\/summary`/);
  assert.match(controller, /@Controller\("customer-center"\)/);
  assert.match(
    controller,
    /@Controller\("admin\/organizations\/:organizationId\/customer-center"\)/,
  );
  assert.match(access, /customer-center\.manage/);
});

test("new customer-center surfaces do not copy reference-brand content", () => {
  const sources = [
    ...customerPages.flatMap((page) => [
      read(`apps/miniapp/pages/${page}/index.ts`),
      read(`apps/miniapp/pages/${page}/index.wxml`),
    ]),
    read("apps/miniapp/pages/profile/index.ts"),
    read("apps/miniapp/pages/profile/index.wxml"),
    read("apps/admin-web/src/customer-center-workspace.tsx"),
  ].join("\n");
  assert.doesNotMatch(sources, /东郊|dongjiao|anmo\.com|4009797999/i);
});

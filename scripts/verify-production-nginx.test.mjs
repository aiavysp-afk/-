import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(
  new URL("../infra/nginx.production.conf", import.meta.url),
  "utf8",
);

test("production nginx exposes every customer authentication route", () => {
  for (const route of [
    "wechat-miniapp",
    "wechat-phone",
    "sms-phone/(?:request|confirm)",
    "me",
    "logout",
  ]) {
    assert.ok(config.includes(route), `missing route expression: ${route}`);
  }
});

test("production nginx exposes staff pairing and the technician workbench without opening a catch-all API", () => {
  assert.ok(config.includes("/v1/auth/browser-login/"));
  for (const action of [
    "config",
    "create",
    "inspect",
    "approve",
    "poll",
    "claim",
    "cancel",
  ])
    assert.ok(config.includes(action));
  assert.ok(config.includes("/v1/technician/workbench"));
  assert.ok(config.includes("(?:route|actions)"));
});

test("production nginx keeps unknown API paths closed", () => {
  assert.match(config, /return 404/);
  assert.doesNotMatch(config, /location \/v1\/ \{/);
});

test("production nginx exposes exact payment creation and callback routes", () => {
  assert.ok(config.includes("/v1/orders/[^/]+/payment-intent"));
  assert.ok(config.includes("/v1/payments/wechat/(?:notify|refund-notify)"));
  assert.ok(config.includes("orders/[^/]+/close"));
  assert.ok(config.includes("[^/]+/reconcile"));
  assert.match(config, /limit_except POST \{ deny all; \}/);
});

test("root-domain maintenance config publishes only the technician client subtree", () => {
  const maintenance = readFileSync(
    new URL("../infra/maintenance/mtsc.top.conf", import.meta.url),
    "utf8",
  );
  assert.ok(maintenance.includes("location ^~ /technician/"));
  assert.ok(maintenance.includes("apps/workbench-h5/dist/"));
  assert.ok(maintenance.includes("connect-src https://api.mtsc.top"));
  assert.match(maintenance, /location \/ \{ error_page 503/);
});

test("production release builds the technician client against the live API", () => {
  const deploy = readFileSync(
    new URL("./deploy-production-api.sh", import.meta.url),
    "utf8",
  );
  assert.ok(deploy.includes("--filter '@zydj/workbench-h5...'"));
  assert.ok(deploy.includes("VITE_API_BASE_URL=https://api.mtsc.top/v1"));
  assert.ok(deploy.includes("apps/workbench-h5/dist/index.html"));
});

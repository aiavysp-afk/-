import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(
  new URL("../infra/nginx.production.conf", import.meta.url),
  "utf8",
);

function locationBlock(declaration) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim() === `location ${declaration} {`,
  );
  assert.notEqual(start, -1, `missing nginx location: ${declaration}`);

  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) ?? []).length;
    depth -= (lines[index].match(/\}/g) ?? []).length;
    if (depth === 0) return lines.slice(start, index + 1).join("\n");
  }

  assert.fail(`unterminated nginx location: ${declaration}`);
}

function assertAllowedMethods(declaration, methods) {
  const block = locationBlock(declaration);
  assert.ok(
    block.includes(`limit_except ${methods.join(" ")} { deny all; }`),
    `${declaration} must allow only ${methods.join(", ")}`,
  );
  return block;
}

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

test("production nginx exposes only the three authenticated customer address routes", () => {
  assert.ok(
    config.includes(
      "locations/(?:address-suggestions|address-geocodes|address-verifications)",
    ),
  );
  assert.doesNotMatch(config, /locations\/\.\*/);
});

test("production nginx exposes exact payment creation and callback routes", () => {
  assert.ok(config.includes("/v1/orders/[^/]+/payment-intent"));
  assert.ok(config.includes("/v1/payments/wechat/(?:notify|refund-notify)"));
  assert.ok(config.includes("orders/[^/]+/close"));
  assert.ok(config.includes("[^/]+/reconcile"));
  assert.match(config, /limit_except POST \{ deny all; \}/);
});

test("production nginx keeps public technician reads separate from authenticated writes", () => {
  const publicProfiles = assertAllowedMethods(
    "~ ^/v1/technicians(?:/[^/]+(?:/reviews)?)?$",
    ["GET"],
  );
  assert.doesNotMatch(publicProfiles, /admin|workbench|orders/);

  assertAllowedMethods("= /v1/technician/workbench/profile", ["GET", "PATCH"]);
  assertAllowedMethods(
    "= /v1/technician/workbench/profile/submit-review",
    ["POST"],
  );
  assertAllowedMethods("~ ^/v1/orders/[^/]+/reviews$", ["POST"]);

  assert.doesNotMatch(config, /location\s+\/v1\/technicians\s*\{/);
  assert.doesNotMatch(config, /technician\/workbench\/profile\/\.\*/);
});

test("production nginx exposes exact authenticated admin profile and review moderation routes", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile$",
    ["GET", "PATCH"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile/(?:approve|publish|unpublish)$",
    ["POST"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/reviews$",
    ["GET"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/reviews/[^/]+/(?:publish|hide)$",
    ["POST"],
  );

  assert.doesNotMatch(
    config,
    /location\s+~?\s+\^?\/v1\/admin\/organizations\/\[\^\/\]\+\/technicians\/\[\^\/\]\+\/reviews\/\.\*/,
  );
});

test("root-domain maintenance config publishes only the technician client subtree", () => {
  const maintenance = readFileSync(
    new URL("../infra/maintenance/mtsc.top.conf", import.meta.url),
    "utf8",
  );
  assert.ok(maintenance.includes("location = /technician/"));
  assert.ok(
    maintenance.includes("rewrite ^ /technician/index.html last;"),
  );
  assert.ok(maintenance.includes("location = /technician/index.html"));
  assert.ok(
    maintenance.includes(
      "/var/www/zhongyuan-daojia-technician/current/index.html",
    ),
  );
  assert.ok(maintenance.includes("location ^~ /technician/assets/"));
  assert.ok(
    maintenance.includes(
      "/var/www/zhongyuan-daojia-technician/current/assets/",
    ),
  );
  assert.ok(maintenance.includes("connect-src https://api.mtsc.top"));
  assert.ok(maintenance.includes("img-src 'self' data: https:"));
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
  assert.ok(deploy.includes("web_base=/var/www/zhongyuan-daojia-technician"));
  assert.ok(deploy.includes('ln -sfn "$web_release" "$web_base/current"'));
});

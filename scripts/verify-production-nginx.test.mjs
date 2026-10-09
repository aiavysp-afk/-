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
  assertAllowedMethods(
    "~ ^/v1/auth/(?:wechat-miniapp|wechat-phone|sms-phone/(?:request|confirm))$",
    ["POST"],
  );
  assertAllowedMethods("= /v1/auth/me", ["GET", "OPTIONS"]);
  assertAllowedMethods("= /v1/auth/logout", ["POST", "OPTIONS"]);
});

test("production nginx exposes staff pairing and the technician workbench without opening a catch-all API", () => {
  assertAllowedMethods("= /v1/auth/browser-login/config", ["GET", "OPTIONS"]);
  assertAllowedMethods(
    "~ ^/v1/auth/browser-login/(?:create|poll|claim|cancel)$",
    ["POST", "OPTIONS"],
  );
  assertAllowedMethods("~ ^/v1/auth/browser-login/(?:inspect|approve)$", [
    "POST",
  ]);
  assert.ok(config.includes("/v1/technician/workbench"));
  assert.ok(config.includes("(?:route|actions)"));
});

test("production nginx exposes exact admin identity and MFA routes", () => {
  assertAllowedMethods("= /v1/auth/mfa", ["GET", "OPTIONS"]);
  assertAllowedMethods("~ ^/v1/auth/mfa/(?:enrollment|activate|verify)$", [
    "POST",
    "OPTIONS",
  ]);
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/mfa-recovery-requests/[^/]+/(?:approve|reject)$",
    ["POST", "OPTIONS"],
  );
});

test("production nginx restricts every admin and MFA request to private networks", () => {
  for (const cidr of [
    "127.0.0.1/32 1;",
    "::1/128 1;",
    "10.0.0.0/8 1;",
    "172.16.0.0/12 1;",
    "192.168.0.0/16 1;",
  ]) {
    assert.ok(config.includes(cidr), `missing private network: ${cidr}`);
  }
  assert.ok(config.includes("~^0:/v1/(?:admin/|auth/mfa(?:/|$)) 1;"));
  assert.ok(config.includes("if ($zydj_admin_request_denied) { return 403; }"));
});

test("production nginx evaluates the private-network gate against the URI path", () => {
  assert.ok(
    config.includes(
      'map "$zydj_admin_network_allowed:$uri" $zydj_admin_request_denied {',
    ),
  );
  assert.doesNotMatch(
    config,
    /map "\$zydj_admin_network_allowed:\$request_uri" \$zydj_admin_request_denied/,
  );
});

test("admin TLS vhost exposes the UI only behind unchanged private-network protection", () => {
  const admin = config.slice(config.lastIndexOf("\nserver {"));
  assert.ok(admin.includes("server_name admin.mtsc.top;"));
  assert.ok(
    admin.includes(
      "if ($zydj_admin_network_allowed = 0) { return 503 maintenance; }",
    ),
  );
  assert.ok(admin.includes("proxy_pass http://127.0.0.1:3222;"));
  assert.ok(admin.includes("proxy_set_header Host admin.mtsc.top;"));
  assert.doesNotMatch(admin, /proxy_pass http:\/\/127\.0\.0\.1:321[023]/);
  assert.doesNotMatch(
    admin,
    /proxy_set_header Origin|real_ip_header|set_real_ip_from|default-src 'none'/,
  );
  const geo = config.slice(
    config.indexOf("geo $zydj_admin_network_allowed {"),
    config.indexOf("\n}", config.indexOf("geo $zydj_admin_network_allowed {")) +
      2,
  );
  assert.equal(
    geo.trim(),
    `geo $zydj_admin_network_allowed {
    default 0;
    127.0.0.1/32 1;
    ::1/128 1;
    10.0.0.0/8 1;
    172.16.0.0/12 1;
    192.168.0.0/16 1;
}`,
  );
});

test("production nginx keeps unknown API paths closed", () => {
  assert.match(config, /return 404/);
  assert.doesNotMatch(config, /location \/v1\/ \{/);
});

test("production nginx rejects broad admin and development route exposure", () => {
  const declarations = config
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("location "));

  for (const declaration of declarations) {
    assert.doesNotMatch(declaration, /^location (?:\^~ )?\/v1\/admin\/? \{$/);
    assert.doesNotMatch(
      declaration,
      /^location ~\*? \^\/v1\/admin\/(?:\.\*|\(\?:\.\*\))?\$? \{$/,
    );
    assert.doesNotMatch(
      declaration,
      /^location ~\*? \^\/v1\/admin\/organizations\/\[\^\/\]\+\$? \{$/,
    );
  }

  assert.doesNotMatch(config, /\/v1\/dev(?:\/|\$)/);
  assert.doesNotMatch(config, /dev\/organizations/);
});

test("production nginx exposes dashboard, dispatch, staffing, area and readiness exactly", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/(?:dashboard|dispatch|technicians|service-area|readiness|payments|safety-duty-rosters/current|safety-duty-staff|safety-notifications|safety-notifications-summary|safety-incidents|mfa-recovery-requests)$",
    ["GET", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/dispatch/orders/[^/]+/assign$",
    ["POST", "OPTIONS"],
  );
});

test("production nginx exposes exact catalog, scheduling and audit resources", () => {
  assertAllowedMethods("= /v1/admin/catalog/services", ["GET", "OPTIONS"]);
  assertAllowedMethods(
    "~ ^/v1/admin/catalog/services/[^/]+/(?:publish|unpublish)$",
    ["POST", "OPTIONS"],
  );
  assertAllowedMethods("= /v1/admin/scheduling/shifts", [
    "GET",
    "POST",
    "OPTIONS",
  ]);
  assertAllowedMethods("= /v1/admin/audit-logs", ["GET", "OPTIONS"]);
});

test("production nginx exposes exact admin payment and refund resources", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/payments/[^/]+/refunds$",
    ["GET", "POST", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/refunds/[^/]+/(?:approve|reject|submit|reconcile)$",
    ["POST", "OPTIONS"],
  );
});

test("production nginx exposes only concrete admin safety actions", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/(?:safety-duty-rosters|safety-duty-staff/[^/]+/contact|safety-notifications/[^/]+/retry|safety-incidents/[^/]+/(?:acknowledge|close))$",
    ["POST", "OPTIONS"],
  );
  assert.doesNotMatch(config, /location\s+\^~?\s+\/v1\/admin\/.*safety/);
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
  assertAllowedMethods(
    "~ ^/v1/orders/[^/]+/(?:payment-intent|friend-payment)$",
    ["POST"],
  );
  assert.ok(config.includes("/v1/payments/wechat/(?:notify|refund-notify)"));
  assert.ok(config.includes("orders/[^/]+/close"));
  assert.ok(config.includes("[^/]+/reconcile"));
  assert.match(config, /limit_except POST \{ deny all; \}/);
});

test("friend invitations use exact authenticated routes, restricted methods and no capability access log", () => {
  for (const [route, methods] of [
    ['~ "^/v1/friend-payments/[A-Za-z0-9_-]{43}$"', ["GET"]],
    [
      '~ "^/v1/friend-payments/[A-Za-z0-9_-]{43}/payment-intent$"',
      ["GET", "POST"],
    ],
    ['~ "^/v1/friend-payments/[A-Za-z0-9_-]{43}/reconcile$"', ["POST"]],
  ]) {
    const block = assertAllowedMethods(route, methods);
    assert.ok(block.includes("access_log off;"));
    assert.ok(block.includes("error_log /dev/null;"));
    assert.ok(block.includes("proxy_pass http://127.0.0.1:3220;"));
    assert.doesNotMatch(
      block,
      /Origin|Authorization|satisfy any|auth_request off/,
    );
  }
  assertAllowedMethods("= /v1/payments/notifications", ["GET"]);
  assert.doesNotMatch(config, /location (?:\^~ )?\/v1\/friend-payments\/? \{/);
});

test("gateway deployment checks every friend-payment boundary without creating a payment", () => {
  const deploy = readFileSync(
    new URL("./deploy-production-nginx.sh", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "payment-intent|friend-payment",
    "/v1/friend-payments/",
    "location = /v1/payments/notifications",
    "orders/probe/friend-payment",
    "friend-payments/$friend_probe_token/payment-intent",
    "friend-payments/$friend_probe_token/reconcile",
  ]) {
    assert.ok(deploy.includes(marker));
  }
  assert.ok(deploy.includes("[[ $friend_status == 401 ]]"));
});

test("malformed capability paths are unlogged deny-only fallbacks, never broad API exposure", () => {
  const declaration = "location ~* ^/v1/friend-payments(?:/|$)";
  const blocks = config
    .split(declaration)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf("}") + 1));
  assert.equal(blocks.length, 2, "HTTP and TLS each need a deny-only fallback");
  for (const block of blocks) {
    assert.ok(block.includes("access_log off;"));
    assert.ok(block.includes("error_log /dev/null;"));
    assert.ok(block.includes("return 404;"));
    assert.doesNotMatch(block, /proxy_pass|rewrite|301/);
  }
  const tls = config.slice(config.indexOf("server_name api.mtsc.top;"));
  assert.ok(
    tls.indexOf(
      'location ~ "^/v1/friend-payments/[A-Za-z0-9_-]{43}/reconcile$"',
    ) < tls.indexOf(declaration),
  );
  assert.equal(
    (config.match(/error_log \/dev\/null;/g) ?? []).length,
    5,
    "log suppression is limited to capability routes",
  );
});

test("production nginx exposes the exact customer refund and safety incident methods", () => {
  assertAllowedMethods("~ ^/v1/orders/[^/]+/(?:refunds|safety-incidents)$", [
    "GET",
    "POST",
  ]);
  assert.doesNotMatch(config, /location\s+(?:\^~\s+)?\/v1\/orders\/?\s*\{/);
  assert.doesNotMatch(config, /location\s+~\*?\s+\^\/v1\/orders\/?\$?\s*\{/);
});

test("production nginx keeps public technician reads separate from authenticated writes", () => {
  const publicProfiles = assertAllowedMethods(
    "~ ^/v1/technicians(?:/[^/]+(?:/reviews|/photos/[A-Za-z0-9-]+)?)?$",
    ["GET"],
  );
  assert.doesNotMatch(publicProfiles, /admin|workbench|orders/);

  assertAllowedMethods("= /v1/technician/workbench/profile", [
    "GET",
    "PATCH",
    "OPTIONS",
  ]);
  assertAllowedMethods("= /v1/technician/workbench/profile/submit-review", [
    "POST",
    "OPTIONS",
  ]);
  assertAllowedMethods("~ ^/v1/orders/[^/]+/reviews$", ["POST"]);

  assert.doesNotMatch(config, /location\s+\/v1\/technicians\s*\{/);
  assert.doesNotMatch(config, /technician\/workbench\/profile\/\.\*/);
});

test("production photo upload and preview routes keep owner/admin authorization fences", () => {
  assertAllowedMethods("= /v1/technician/workbench/profile/photos", [
    "POST",
    "OPTIONS",
  ]);
  assertAllowedMethods(
    "~ ^/v1/technician/workbench/profile/photos/[A-Za-z0-9-]+$",
    ["GET", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile/photos$",
    ["POST", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile/photos/[A-Za-z0-9-]+$",
    ["GET", "OPTIONS"],
  );
  assert.ok(config.includes("if ($zydj_admin_request_denied) { return 403; }"));
  assert.match(config, /client_max_body_size 1m;/);
});

test("production nginx exposes technician invitations without broadening technician APIs", () => {
  assertAllowedMethods("= /v1/technician-invitations/claim", ["POST"]);
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technician-invitations$",
    ["GET", "POST", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technician-invitations/[^/]+/revoke$",
    ["POST", "OPTIONS"],
  );

  assert.doesNotMatch(
    config,
    /location\s+\/?v1\/technician-invitations\/?\s*\{/,
  );
  assert.doesNotMatch(config, /technician-invitations\/\.\*/);
});

test("production nginx exposes exact authenticated admin profile and review moderation routes", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile$",
    ["GET", "PATCH", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/profile/(?:submit-review|approve|publish|unpublish)$",
    ["POST", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/reviews$",
    ["GET", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/technicians/[^/]+/reviews/[^/]+/(?:publish|hide)$",
    ["POST", "OPTIONS"],
  );

  assert.doesNotMatch(
    config,
    /location\s+~?\s+\^?\/v1\/admin\/organizations\/\[\^\/\]\+\/technicians\/\[\^\/\]\+\/reviews\/\.\*/,
  );
});

test("production nginx exposes only the required customer-center client routes and methods", () => {
  assertAllowedMethods("= /v1/customer-center/newcomer-coupons", [
    "GET",
    "POST",
  ]);
  assertAllowedMethods(
    "~ ^/v1/customer-center(?:/(?:coupons|wallet(?:/ledger)?|settings))?$",
    ["GET"],
  );
  assertAllowedMethods(
    "~ ^/v1/customer-center/wallet/(?:recharges(?:/[^/]+/reconcile)?|first-recharge-reward/claim)$",
    ["POST"],
  );
  assertAllowedMethods("= /v1/customer-center/addresses", ["GET", "POST"]);
  assertAllowedMethods("~ ^/v1/customer-center/addresses/[^/]+$", [
    "PATCH",
    "DELETE",
  ]);
  assertAllowedMethods("= /v1/customer-center/feedback", ["POST"]);
  assertAllowedMethods("= /v1/customer-center/account-deletion", [
    "GET",
    "POST",
  ]);

  assert.doesNotMatch(config, /location\s+\^~?\s+\/v1\/customer-center/);
  assert.doesNotMatch(config, /customer-center\/\.\*/);
  assert.doesNotMatch(config, /customer-center\/\[\^\/\]\+\/\.?\*/);
});

test("production nginx exposes exact customer-center admin resources without a broad admin prefix", () => {
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/customer-center/config$",
    ["GET", "PATCH", "OPTIONS"],
  );
  assertAllowedMethods(
    "~ ^/v1/admin/organizations/[^/]+/customer-center/summary$",
    ["GET", "OPTIONS"],
  );

  assert.doesNotMatch(
    config,
    /location\s+~?\s+\^?\/v1\/admin\/organizations\/\[\^\/\]\+\/customer-center(?:\/\.\*)?\s*\{/,
  );
});

test("financial wallet ledger uses the private gate and only an exact GET path", () => {
  const declaration =
    "~ ^/v1/admin/organizations/[^/]+/customer-center/wallet-ledger$";
  const block = assertAllowedMethods(declaration, ["GET"]);
  // Nginx normally grants HEAD together with GET; explicitly reject every other method.
  assert.ok(block.includes("if ($request_method != GET) { return 405; }"));
  assert.ok(block.includes("proxy_pass http://127.0.0.1:3220;"));
  assert.ok(config.includes("~^0:/v1/(?:admin/|auth/mfa(?:/|$)) 1;"));
  assert.ok(config.includes("if ($zydj_admin_request_denied) { return 403; }"));
  const pattern = new RegExp(
    block
      .split("\n")[0]
      .trim()
      .replace(/^location ~ /, "")
      .replace(/ \{$/, ""),
  );
  assert.ok(
    pattern.test("/v1/admin/organizations/org-1/customer-center/wallet-ledger"),
  );
  for (const path of [
    "/v1/admin/organizations/org-1/customer-center/wallet-ledger/",
    "/v1/admin/organizations/org-1/customer-center/wallet-ledger/extra",
    "/v1/admin/organizations/org-1/customer-center/wallet-ledger-export",
  ]) {
    assert.equal(pattern.test(path), false);
  }
  assert.doesNotMatch(
    block,
    /satisfy any|auth_request off|proxy_set_header Origin|proxy_set_header Authorization/,
  );
});

test("gateway publication requires the exact wallet ledger marker and unauthenticated GET probes", () => {
  const deploy = readFileSync(
    new URL("./deploy-production-nginx.sh", import.meta.url),
    "utf8",
  );
  assert.ok(
    deploy.includes(
      "'location ~ ^/v1/admin/organizations/[^/]+/customer-center/wallet-ledger$ {'",
    ),
  );
  assert.ok(
    deploy.includes(
      "wallet_ledger_route=/v1/admin/organizations/probe/customer-center/wallet-ledger",
    ),
  );
  assert.ok(
    deploy.includes("for wallet_ledger_host in api.mtsc.top admin.mtsc.top"),
  );
  const probe = deploy.slice(
    deploy.indexOf("wallet_ledger_status=$(curl"),
    deploy.indexOf("# Invitations never bypass login"),
  );
  assert.ok(probe.includes("--request GET"));
  assert.ok(probe.includes("[[ $wallet_ledger_status == 401 ]]"));
  assert.doesNotMatch(probe, /Authorization|Cookie|Bearer|--data|--insecure/);
});

test("root-domain maintenance config publishes only the technician client subtree", () => {
  const maintenance = readFileSync(
    new URL("../infra/maintenance/mtsc.top.conf", import.meta.url),
    "utf8",
  );
  assert.ok(maintenance.includes("location = /technician/"));
  assert.ok(maintenance.includes("rewrite ^ /technician/index.html last;"));
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
  assert.equal(
    (maintenance.match(/img-src 'self' data: blob: https:/g) ?? []).length,
    2,
  );
  assert.equal(
    (maintenance.match(/script-src 'self'; frame-ancestors 'none'/g) ?? [])
      .length,
    2,
  );
  assert.doesNotMatch(
    maintenance,
    /script-src[^;]*blob:|connect-src[^;]*blob:/,
  );
  assert.match(maintenance, /location \/ \{ error_page 503/);
});

test("production release builds the technician client while the admin stays private", () => {
  const deploy = readFileSync(
    new URL("./deploy-production-api.sh", import.meta.url),
    "utf8",
  );
  assert.ok(deploy.includes("--filter '@zydj/workbench-h5...'"));
  assert.ok(deploy.includes("VITE_API_BASE_URL=https://api.mtsc.top/v1"));
  assert.ok(deploy.includes("apps/workbench-h5/dist/index.html"));
  assert.ok(deploy.includes("web_base=/var/www/zhongyuan-daojia-technician"));
  assert.ok(
    deploy.includes(
      'replace_current_link "$web_release" "$web_base/current" activate',
    ),
  );
  assert.doesNotMatch(deploy, /@zydj\/admin-web|zhongyuan-daojia-admin/);
});

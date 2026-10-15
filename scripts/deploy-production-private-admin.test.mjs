import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const deploy = readFileSync(new URL("./deploy-production-private-admin.sh", import.meta.url), "utf8");
test("private admin deployment uses only its own root and the existing non-root production identity", () => {
  assert.ok(deploy.includes("base=/opt/zhongyuan-daojia-admin"));
  assert.ok(deploy.includes("User=zydj")); assert.ok(deploy.includes("Group=zydj"));
  assert.ok(deploy.includes("NoNewPrivileges=true")); assert.ok(deploy.includes("ProtectSystem=strict"));
  assert.ok(deploy.includes("flock -n 9"));
  assert.ok(deploy.indexOf('for directory in "$base/releases" "$base/backups"') < deploy.indexOf('install -d -o root -g zydj -m 0750 "$base"'));
  assert.ok(deploy.includes('$(readlink -f "$source_release") == "$source_release"'));
  assert.doesNotMatch(deploy, /prisma migrate|pg_dump|SEED_|AUTH_PROVIDER=|CORS_ORIGINS=|systemctl (?:restart|stop) zhongyuan-daojia-api/);
});
test("frontend builds never inherit API secrets or modify the live API release", () => {
  assert.doesNotMatch(deploy, /source \/etc\/zhongyuan-daojia\/api\.env|set -a|cd "\$source_release"/);
  assert.ok(deploy.includes('readFileSync("/etc/zhongyuan-daojia/api.env", "utf8")'));
  assert.ok(deploy.includes('includes("https://admin.mtsc.top")'));
  assert.ok(deploy.includes('cd "$release/source"'));
  assert.ok(deploy.includes('$(<"$source_release/DEPLOY_COMMIT") == "$release_id"'));
  assert.ok(deploy.includes("VITE_API_BASE_URL=/v1"));
  assert.ok(deploy.includes("--filter '@zydj/admin-web...'"));
});
test("service runtime is executable by production zydj without expanding acceptance permissions", () => {
  assert.ok(deploy.includes("service_node=/usr/bin/node"));
  assert.ok(deploy.includes('runuser -u zydj -- /usr/bin/env -i PATH=/usr/bin:/bin "$service_node" -e'));
  assert.ok(deploy.includes('Number(process.versions.node.split(".")[0]) < 22'));
  assert.ok(deploy.includes("ExecStart=$service_node $release/serve-production-private-admin.mjs"));
  assert.ok(deploy.indexOf('runuser -u zydj --') < deploy.indexOf("activated=true"));
  assert.doesNotMatch(deploy, /ExecStart=\$node_root|usermod|gpasswd|chmod[^\n]*acceptance|chown[^\n]*acceptance/);
});
test("unit and artifact paths bind exact immutable releases and activation rolls back", () => {
  assert.ok(deploy.includes('release="$base/releases/$release_id"'));
  assert.ok(deploy.includes("WorkingDirectory=$release"));
  assert.ok(deploy.includes("Environment=PRIVATE_ADMIN_ROOT=$release/dist"));
  assert.ok(deploy.includes('candidate="$release/zhongyuan-daojia-private-admin.service"'));
  assert.ok(deploy.includes('systemd-analyze verify "$candidate"'));
  assert.ok(deploy.includes('readlink -f "/proc/$pid/cwd"'));
  assert.ok(deploy.includes('cp -a "$backup" "$unit_path"'));
  assert.ok(deploy.includes('replace_link "$previous" rollback'));
  assert.ok(deploy.includes('wait_for_release "$previous"'));
  assert.ok(deploy.includes("exit 70")); assert.doesNotMatch(deploy, /rm -rf|ln -sfn|set \+e/);
});

test("new customer directory routes are anonymously probed without breaking old-release rollback", () => {
  const start = deploy.indexOf("verify_customer_directory() {");
  const end = deploy.indexOf("\nactivated=false", start);
  assert.ok(start >= 0 && end > start);
  const probe = deploy.slice(start, end);
  assert.ok(probe.includes("route=/v1/admin/organizations/probe/customer-center/customers"));
  assert.ok(probe.includes("--request GET"));
  assert.ok(probe.includes("--request POST"));
  assert.ok(probe.includes('$route/probe/reveal-phone'));
  assert.equal((probe.match(/== 401/g) ?? []).length, 2);
  assert.doesNotMatch(probe, /Authorization|Cookie|Bearer|--data|--insecure/);
  assert.ok(deploy.includes('wait_for_release "$release"\nverify_customer_directory\nsystemctl enable'));
  const rollbackStart = deploy.indexOf("rollback() {");
  const rollbackEnd = deploy.indexOf("\non_error() {", rollbackStart);
  assert.doesNotMatch(deploy.slice(rollbackStart, rollbackEnd), /verify_customer_directory/);
  assert.ok(deploy.slice(rollbackStart, rollbackEnd).includes('wait_for_release "$previous"'));
});

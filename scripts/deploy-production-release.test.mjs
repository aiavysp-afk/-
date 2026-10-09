import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const deploy = readFileSync(
  new URL("./deploy-production-api.sh", import.meta.url),
  "utf8",
);
const nginx = readFileSync(
  new URL("../infra/nginx.production.conf", import.meta.url),
  "utf8",
);
const nginxDeploy = readFileSync(
  new URL("./deploy-production-nginx.sh", import.meta.url),
  "utf8",
);

function serverBlock(serverName) {
  const lines = nginx.split(/\r?\n/);
  const nameIndex = lines.findIndex(
    (line) => line.trim() === `server_name ${serverName};`,
  );
  assert.notEqual(nameIndex, -1, `missing server_name ${serverName}`);

  let start = nameIndex;
  while (start >= 0 && lines[start].trim() !== "server {") start -= 1;
  assert.notEqual(start, -1, `missing server block for ${serverName}`);

  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) ?? []).length;
    depth -= (lines[index].match(/\}/g) ?? []).length;
    if (depth === 0) return lines.slice(start, index + 1).join("\n");
  }

  assert.fail(`unterminated server block for ${serverName}`);
}

test("production release locks deployment and backs up the same local database it migrates", () => {
  assert.ok(deploy.includes('exec 9>"$base/deploy.lock"'));
  assert.ok(deploy.includes("flock -n 9"));
  assert.ok(deploy.includes('database !== "zhongyuan_daojia"'));
  assert.ok(deploy.includes("localHosts"));
  assert.match(deploy, /const host = url\.hostname/);
  assert.match(deploy, /const port = url\.port \|\| "5432"/);
  assert.match(deploy, /"--host",\s+host/);
  assert.match(deploy, /"--port",\s+port/);
  assert.match(deploy, /"--dbname",\s+database/);
  assert.ok(deploy.includes("dumpEnvironment.PGPASSWORD = password"));
  assert.ok(
    deploy.includes(
      'PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    ),
  );
  assert.doesNotMatch(deploy, /dumpEnvironment\s*=\s*\{\s*\.\.\.process\.env/);
  assert.doesNotMatch(deploy, /dumpEnvironment\.(?:DATABASE_URL|BACKUP_PATH)/);
  assert.ok(deploy.includes('spawnSync("runuser", args'));
  assert.doesNotMatch(deploy, /pg_dump -Fc -d zhongyuan_daojia/);
  assert.doesNotMatch(deploy, /console\.(?:log|error)\([^)]*(?:raw|password)/);
  assert.ok(deploy.includes("pg_restore --list"));
  assert.ok(deploy.includes("prisma migrate deploy"));
  assert.ok(deploy.includes("prisma migrate status"));
});

test("production release verifies the exact API process before switching the technician web", () => {
  const apiSwitch = deploy.indexOf(
    'replace_current_link "$release" "$base/current" activate',
  );
  const apiVerify = deploy.indexOf('wait_for_api_release "$release"');
  const webSwitch = deploy.indexOf(
    'replace_current_link "$web_release" "$web_base/current" activate',
  );

  assert.ok(apiSwitch >= 0);
  assert.ok(apiVerify > apiSwitch);
  assert.ok(webSwitch > apiVerify);
  assert.ok(deploy.includes('readlink -f "/proc/$main_pid/cwd"'));
  assert.ok(deploy.includes("/v1/catalog/services"));
  assert.doesNotMatch(deploy, /ln -sfn/);
});

test("production photo decoder is verified before backup, migrations and switches", () => {
  const decoder = deploy.indexOf('import sharp from "sharp";');
  assert.ok(decoder > deploy.indexOf('"$pnpm_bin" --filter @zydj/api build'));
  assert.ok(decoder < deploy.indexOf('backup="$base/backups/'));
  assert.ok(decoder < deploy.indexOf("prisma migrate deploy"));
  assert.ok(deploy.includes('cd "$release/apps/api"'));
  assert.ok(deploy.includes('metadata.format !== "jpeg"'));
  assert.ok(deploy.includes("limitInputPixels: 4"));
});

test("production rollback verifies links, service cwd and DB-backed health", () => {
  for (const expected of [
    'restore_current_link "$previous_web" "$web_base/current"',
    'restore_current_link "$previous" "$base/current"',
    'wait_for_api_release "$previous"',
    "CRITICAL: deployment failed and rollback is incomplete",
  ]) {
    assert.ok(deploy.includes(expected), `missing rollback check: ${expected}`);
  }
  assert.doesNotMatch(deploy, /set \+e/);
  assert.ok(deploy.includes("exit 70"));
});

test("admin UI is restricted to the existing private network gate while public users get maintenance", () => {
  const admin = serverBlock("admin.mtsc.top");
  assert.ok(admin.includes("return 503 maintenance"));
  assert.ok(admin.includes('Retry-After "3600"'));
  assert.ok(admin.includes("if ($zydj_admin_network_allowed = 0) { return 503 maintenance; }"));
  assert.ok(admin.includes("proxy_pass http://127.0.0.1:3222;"));
  assert.ok(admin.includes("proxy_set_header Host admin.mtsc.top;"));
  assert.doesNotMatch(admin, /proxy_set_header Origin|real_ip_header|set_real_ip_from/);
  assert.doesNotMatch(
    admin,
    /root \/var\/www\/zhongyuan-daojia-admin|try_files/,
  );
  assert.doesNotMatch(deploy, /@zydj\/admin-web|zhongyuan-daojia-admin/);
});

test("Nginx deployment validates, reloads, probes and restores the exact active vhost", () => {
  assert.ok(nginxDeploy.includes("readlink -f"));
  assert.ok(nginxDeploy.includes("current_nginx_dump=$(nginx -T 2>&1)"));
  assert.ok(
    nginxDeploy.includes('loaded_target=$(readlink -f -- "$loaded_vhost")'),
  );
  assert.ok(nginxDeploy.includes('loaded_target == "$target"'));
  assert.ok(
    nginxDeploy.includes("server_name[[:space:]][^;]*admin\\.mtsc\\.top"),
  );
  assert.ok(
    nginxDeploy.includes(
      "Refusing a target that is not the loaded api/admin production vhost",
    ),
  );
  assert.ok(nginxDeploy.includes("nginx -t"));
  assert.ok(nginxDeploy.includes("conflicting server name"));
  assert.ok(nginxDeploy.includes("systemctl reload nginx.service"));
  assert.ok(nginxDeploy.includes("restore_nginx"));
  assert.ok(nginxDeploy.includes("CRITICAL: Nginx deployment failed"));
  assert.ok(nginxDeploy.includes("--resolve api.mtsc.top:443:127.0.0.1"));
  assert.ok(nginxDeploy.includes("admin_status == 200"));
  assert.ok(nginxDeploy.includes("public_admin_status == 503"));
  assert.ok(nginxDeploy.includes("private_catalog_status == 401"));
  assert.ok(nginxDeploy.includes("private_unknown_status == 404"));
  assert.ok(nginxDeploy.includes("wait_for_private_gateway"));
  assert.ok(nginxDeploy.includes("systemctl is-active --quiet zhongyuan-daojia-private-admin.service"));
  assert.ok(nginxDeploy.includes('admin_release="/opt/zhongyuan-daojia-admin/releases/$release_id"'));
  assert.ok(nginxDeploy.includes('$(readlink -f /opt/zhongyuan-daojia-admin/current) == "$admin_release"'));
  assert.ok(nginxDeploy.includes('readlink -f "/proc/$admin_pid/cwd"'));
  assert.ok(nginxDeploy.includes('$(<"$admin_release/DEPLOY_COMMIT") == "$release_id"'));
  assert.ok(nginxDeploy.includes("customer_status == 401"));
  assert.ok(
    nginxDeploy.includes(
      'release_config="$base/releases/$release_id/infra/nginx.production.conf"',
    ),
  );
  assert.ok(nginxDeploy.includes('cp -- "$release_config" "$candidate"'));
});

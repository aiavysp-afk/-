#!/usr/bin/env bash
# Deploy one exact public main commit to the production API and technician H5.
# The public admin site intentionally remains in maintenance mode until a
# private network, VPN, or independent identity gateway is in place.
set -euo pipefail
umask 077

base=/opt/zhongyuan-daojia
web_base=/var/www/zhongyuan-daojia-technician
release_id=${1:?Pass the exact lowercase 40-character main commit SHA}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ -L "$base/current" && -d "$base/releases" && -d "$base/backups" ]] || exit 1
command -v flock >/dev/null
exec 9>"$base/deploy.lock"
flock -n 9 || { echo "Another production deployment is already running"; exit 1; }
[[ $(systemctl show zhongyuan-daojia-api.service -p WorkingDirectory --value) == "$base/current/apps/api" ]] || exit 1
[[ $(systemctl show zhongyuan-daojia-api.service -p EnvironmentFiles --value) == */etc/zhongyuan-daojia/api.env* ]] || exit 1

release="$base/releases/$release_id"
archive="$base/$release_id.tar.gz"
web_release="$web_base/releases/$release_id"
[[ ! -e "$release" && ! -e "$archive" && ! -e "$web_release" ]] || { echo "Release already exists"; exit 1; }
free_kib=$(df -Pk "$base" | awk 'NR==2 {print $4}')
(( free_kib > 3145728 )) || { echo "Insufficient disk reserve"; exit 1; }

curl --fail --location --connect-timeout 10 --max-time 180 \
  "https://codeload.github.com/aiavysp-afk/-/tar.gz/$release_id" \
  --output "$archive"
tar -tzf "$archive" >/dev/null
mkdir -m 0750 "$release"
tar -xzf "$archive" --strip-components=1 -C "$release"
rm -f "$archive"
printf '%s\n' "$release_id" > "$release/DEPLOY_COMMIT"
[[ -f "$release/pnpm-lock.yaml" && -f "$release/apps/api/prisma/schema.prisma" ]] || exit 1
if grep -RIl --exclude='*.example' --exclude='*.md' --exclude-dir=.git \
  -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' "$release" | grep -q .; then
  echo "Private key material found in release"
  exit 1
fi

node_root=/opt/zhongyuan-daojia-acceptance/runtime/node-v24.19.0-linux-x64
pnpm_bin=/opt/zhongyuan-daojia-acceptance/tooling/node_modules/.bin/pnpm
export PATH="$node_root/bin:$(dirname "$pnpm_bin"):$PATH"
export NPM_CONFIG_CACHE="$base/npm-cache"
[[ -x "$node_root/bin/node" && -x "$pnpm_bin" ]] || exit 1
cd "$release"
"$pnpm_bin" install --frozen-lockfile --ignore-scripts \
  --filter '@zydj/api...' \
  --filter '@zydj/workbench-h5...' \
  --store-dir "$base/store"
"$pnpm_bin" --filter @zydj/contracts build
"$pnpm_bin" --filter @zydj/api exec prisma generate
"$pnpm_bin" --filter @zydj/api build
# Optional native image packages must work on this release's Linux runtime
# before a backup, migration, or release switch touches production state.
(
  cd "$release/apps/api"
  "$node_root/bin/node" --input-type=module <<'NODE'
import sharp from "sharp";
const bytes = await sharp({
  create: { width: 2, height: 2, channels: 3, background: "#146c53" },
}).jpeg().toBuffer();
const metadata = await sharp(bytes, { limitInputPixels: 4 }).metadata();
if (metadata.format !== "jpeg" || metadata.width !== 2 || metadata.height !== 2) {
  throw new Error("Production photo decoder verification failed");
}
console.log("Production photo decoder verified");
NODE
)
VITE_API_BASE_URL=https://api.mtsc.top/v1 \
  "$pnpm_bin" --filter @zydj/workbench-h5 build
[[ -f "$release/apps/workbench-h5/dist/index.html" ]] || exit 1
getent group www-data >/dev/null
install -d -o root -g www-data -m 0755 "$web_base" "$web_base/releases"
[[ ! -e "$web_base/current" || -L "$web_base/current" ]] || exit 1
install -d -o root -g www-data -m 0755 "$web_release"
cp -a "$release/apps/workbench-h5/dist/." "$web_release/"
chown -R root:www-data "$web_release"
find "$web_release" -type d -exec chmod 0755 {} +
find "$web_release" -type f -exec chmod 0644 {} +

set -a
source /etc/zhongyuan-daojia/api.env
set +a
backup="$base/backups/database-before-$release_id-$(date -u +%Y%m%dT%H%M%S).dump"
BACKUP_PATH="$backup.partial" "$node_root/bin/node" <<'NODE'
const { spawnSync } = require("node:child_process");
const { closeSync, openSync } = require("node:fs");

function refuse(message) {
  console.error(message);
  process.exit(1);
}

const raw = process.env.DATABASE_URL;
if (!raw) refuse("DATABASE_URL is missing; refusing backup and migration");

let url;
let database;
let username;
let password;
try {
  url = new URL(raw);
  database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  username = decodeURIComponent(url.username);
  password = decodeURIComponent(url.password);
} catch {
  refuse("DATABASE_URL is invalid; refusing backup and migration");
}

const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
const port = url.port || "5432";
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !localHosts.has(host) ||
  database !== "zhongyuan_daojia"
) {
  refuse(
    "DATABASE_URL is not the local zhongyuan_daojia database; refusing mismatched backup and migration",
  );
}

const dumpEnvironment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};
if (password) dumpEnvironment.PGPASSWORD = password;

const args = [
  "-u",
  "postgres",
  "--",
  "pg_dump",
  "-Fc",
  "--no-password",
  "--host",
  host,
  "--port",
  port,
  "--dbname",
  database,
];
if (username) args.push("--username", username);

let output;
let result;
try {
  output = openSync(process.env.BACKUP_PATH, "wx", 0o600);
  result = spawnSync("runuser", args, {
    env: dumpEnvironment,
    stdio: ["ignore", output, "inherit"],
  });
} catch {
  refuse("Could not start the database backup");
} finally {
  if (output !== undefined) closeSync(output);
}

if (result.error || result.status !== 0) {
  refuse("Database backup failed");
}
NODE
pg_restore --list "$backup.partial" >/dev/null
mv "$backup.partial" "$backup"
"$pnpm_bin" --filter @zydj/api exec prisma migrate deploy
"$pnpm_bin" --filter @zydj/api exec prisma migrate status

previous=$(readlink -f "$base/current")
previous_web=""
if [[ -L "$web_base/current" ]]; then
  previous_web=$(readlink -f "$web_base/current")
fi
printf '%s\n' "$previous" > "$base/backups/previous-release-$release_id.txt"
printf '%s\n' "$previous_web" > "$base/backups/previous-technician-web-$release_id.txt"
chown -R root:zydj "$release"
chmod -R g+rX "$release"

replace_current_link() {
  local target=$1
  local link=$2
  local operation=$3
  local candidate="${link}.${operation}-${release_id}"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || {
    echo "Stale release switch candidate: $candidate"
    return 1
  }
  ln -s "$target" "$candidate"
  mv -Tf "$candidate" "$link"
}

restore_current_link() {
  local previous_target=$1
  local link=$2
  if [[ -n "$previous_target" ]]; then
    replace_current_link "$previous_target" "$link" rollback
  else
    rm -f "$link"
  fi
}

verify_api_release() {
  local expected_release=$1
  local main_pid
  main_pid=$(systemctl show zhongyuan-daojia-api.service -p MainPID --value)
  [[ $main_pid =~ ^[1-9][0-9]*$ ]]
  [[ $(readlink -f "/proc/$main_pid/cwd") == "$expected_release/apps/api" ]]
  curl --fail --silent http://127.0.0.1:3220/v1/health >/dev/null
  curl --fail --silent http://127.0.0.1:3220/v1/catalog/services >/dev/null
}

wait_for_api_release() {
  local expected_release=$1
  for _ in {1..30}; do
    if verify_api_release "$expected_release"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

activation_started=false
rollback_release() {
  trap - ERR
  local failed=0
  echo "Rolling back application links"
  if ! restore_current_link "$previous_web" "$web_base/current"; then
    echo "ROLLBACK ERROR: technician web link was not restored" >&2
    failed=1
  fi
  if ! restore_current_link "$previous" "$base/current"; then
    echo "ROLLBACK ERROR: API link was not restored" >&2
    failed=1
  fi
  if [[ $(readlink -f "$base/current") != "$previous" ]]; then
    echo "ROLLBACK ERROR: API link verification failed" >&2
    failed=1
  fi
  if [[ -n "$previous_web" && $(readlink -f "$web_base/current") != "$previous_web" ]]; then
    echo "ROLLBACK ERROR: technician web link verification failed" >&2
    failed=1
  fi
  if ! systemctl restart zhongyuan-daojia-api.service; then
    echo "ROLLBACK ERROR: previous API service did not restart" >&2
    failed=1
  elif ! wait_for_api_release "$previous"; then
    echo "ROLLBACK ERROR: previous API release did not become healthy" >&2
    failed=1
  fi
  (( failed == 0 ))
}

on_activation_error() {
  local status=$?
  if [[ "$activation_started" == true ]] && ! rollback_release; then
    echo "CRITICAL: deployment failed and rollback is incomplete" >&2
    exit 70
  fi
  exit "$status"
}
trap on_activation_error ERR

activation_started=true
replace_current_link "$release" "$base/current" activate
[[ $(readlink -f "$base/current") == "$release" ]]
if ! systemctl restart zhongyuan-daojia-api.service; then
  if ! rollback_release; then
    echo "CRITICAL: restart failed and rollback is incomplete" >&2
    exit 70
  fi
  exit 1
fi
if ! wait_for_api_release "$release"; then
  if ! rollback_release; then
    echo "CRITICAL: health check failed and rollback is incomplete" >&2
    exit 70
  fi
  echo "Health check failed; application links rolled back"
  exit 1
fi

# Publish the static client only after the exact API process and a DB-backed
# catalog request have succeeded.
replace_current_link "$web_release" "$web_base/current" activate
[[ $(readlink -f "$web_base/current") == "$web_release" ]]
[[ -r "$web_base/current/index.html" ]]

activation_started=false
trap - ERR
echo "Production API and technician web release active: $release_id"

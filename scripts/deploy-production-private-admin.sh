#!/usr/bin/env bash
# Deploy a private production admin separately from the acceptance stack and API.
# Does not migrate databases, seed people, change API secrets or enable payouts.
set -euo pipefail
umask 077

base=/opt/zhongyuan-daojia-admin
production=/opt/zhongyuan-daojia
unit=zhongyuan-daojia-private-admin.service
unit_path=/etc/systemd/system/zhongyuan-daojia-private-admin.service
release_id=${1:?Pass the exact lowercase 40-character commit SHA}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ ! -L "$base" && ( ! -e "$base" || -d "$base" ) ]] || exit 1
[[ -L "$production/current" && -d "$production/releases" ]] || exit 1
[[ $(systemctl show zhongyuan-daojia-api.service -p User --value) == zydj ]] || exit 1
[[ $(systemctl show zhongyuan-daojia-api.service -p Group --value) == zydj ]] || exit 1
[[ $(systemctl show zhongyuan-daojia-api.service -p WorkingDirectory --value) == "$production/current/apps/api" ]] || exit 1
systemctl is-active --quiet zhongyuan-daojia-api.service
getent passwd zydj >/dev/null
getent group zydj >/dev/null
for directory in "$base/releases" "$base/backups"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 1
done
# Existing children must be verified before install -d can adjust permissions.
[[ $(readlink -f "$base") == "$base" ]] || exit 1
install -d -o root -g zydj -m 0750 "$base" "$base/releases" "$base/backups"
[[ $(readlink -f "$base") == "$base" && ! -L "$base/releases" && ! -L "$base/backups" ]] || exit 1
command -v flock >/dev/null
exec 9>"$base/deploy.lock"
flock -n 9 || { echo "Another private admin deployment is already running"; exit 1; }
[[ ! -e "$base/current" || -L "$base/current" ]] || exit 1
if [[ -L "$base/current" ]]; then
  previous=$(readlink -f "$base/current")
  [[ $previous =~ ^/opt/zhongyuan-daojia-admin/releases/[0-9a-f]{40}$ ]] || exit 1
else
  previous=""
fi

node_root=/opt/zhongyuan-daojia-acceptance/runtime/node-v24.19.0-linux-x64
pnpm_bin=/opt/zhongyuan-daojia-acceptance/tooling/node_modules/.bin/pnpm
service_node=/usr/bin/node
[[ -x "$node_root/bin/node" && -x "$pnpm_bin" ]] || exit 1
# Root may use the acceptance runtime to build. The production zydj service must
# use its existing system Node, not traverse another service's private runtime.
# Check execution as the exact runtime identity before any release activation.
runuser -u zydj -- /usr/bin/env -i PATH=/usr/bin:/bin "$service_node" -e \
  'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Private admin runtime requires Node 22 or newer"); process.exit(1); }'
export PATH="$node_root/bin:$(dirname "$pnpm_bin"):$PATH"
export NPM_CONFIG_CACHE="$base/npm-cache"
# Read only these non-secret deployment gates. Never source API credentials into
# frontend build processes or change its existing CORS/identity configuration.
"$node_root/bin/node" --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const text = readFileSync("/etc/zhongyuan-daojia/api.env", "utf8");
function value(key) {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(key + "="));
  const raw = line?.slice(key.length + 1).trim() ?? "";
  return /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
}
if (value("NODE_ENV") !== "production" || value("AUTH_PROVIDER") !== "wechat" ||
    value("STAFF_BROWSER_LOGIN_ENABLED") !== "true" ||
    !value("CORS_ORIGINS").split(",").map((s) => s.trim()).includes("https://admin.mtsc.top")) {
  throw Error("Production WeChat browser login and the existing HTTPS admin Origin are required");
}
NODE
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3220/v1/health >/dev/null
if ss -H -ltn 'sport = :3222' | grep -q .; then
  systemctl is-active --quiet "$unit" || { echo "Port 3222 is occupied by another service"; exit 1; }
  existing_pid=$(systemctl show "$unit" -p MainPID --value)
  [[ $existing_pid =~ ^[1-9][0-9]*$ ]] || exit 1
  [[ $(readlink -f "/proc/$existing_pid/cwd") == "$previous" ]] || exit 1
fi
free_kib=$(df -Pk "$base" | awk 'NR==2 {print $4}')
(( free_kib > 3145728 )) || { echo "Insufficient disk reserve"; exit 1; }

release="$base/releases/$release_id"
archive="$base/$release_id.tar.gz"
[[ ! -e "$release" && ! -e "$archive" ]] || { echo "Private admin release already exists"; exit 1; }
install -d -o root -g zydj -m 0750 "$release" "$release/source"
source_release="$production/releases/$release_id"
if [[ -f "$source_release/DEPLOY_COMMIT" && $(<"$source_release/DEPLOY_COMMIT") == "$release_id" ]]; then
  [[ $(readlink -f "$source_release") == "$source_release" && ! -L "$source_release" ]] || exit 1
  # Copy source only: never install or prune packages in the running API release.
  tar --exclude='./node_modules' --exclude='*/node_modules' --exclude='*/dist' \
    -cf - -C "$source_release" . | tar -xf - -C "$release/source"
else
  curl --fail --location --connect-timeout 10 --max-time 180 \
    "https://codeload.github.com/aiavysp-afk/-/tar.gz/$release_id" --output "$archive"
  tar -tzf "$archive" >/dev/null
  tar -xzf "$archive" --strip-components=1 -C "$release/source"
  # Keep the exact downloaded archive recoverable; no recursive deletion.
fi
printf '%s\n' "$release_id" > "$release/DEPLOY_COMMIT"
[[ -f "$release/source/pnpm-lock.yaml" && -f "$release/source/scripts/serve-production-private-admin.mjs" ]] || exit 1
cd "$release/source"
"$pnpm_bin" install --frozen-lockfile --ignore-scripts --filter '@zydj/admin-web...' --store-dir "$base/store"
"$pnpm_bin" --filter @zydj/contracts build
VITE_API_BASE_URL=/v1 "$pnpm_bin" --filter @zydj/admin-web build
[[ -f "$release/source/apps/admin-web/dist/index.html" ]] || exit 1
if grep -R -E 'http://127\.0\.0\.1:3100/v1|https://api\.mtsc\.top/v1/auth/' "$release/source/apps/admin-web/dist" >/dev/null; then
  echo "Admin build contains an unexpected API endpoint"; exit 1
fi
grep -R -F '"/v1"' "$release/source/apps/admin-web/dist/assets" >/dev/null || exit 1
cp -a "$release/source/apps/admin-web/dist" "$release/dist"
cp "$release/source/scripts/serve-production-private-admin.mjs" "$release/serve-production-private-admin.mjs"
chown -R root:zydj "$release"
chmod -R g+rX "$release"

backup="$base/backups/unit-before-$release_id-$(date -u +%Y%m%dT%H%M%S)"
old_active=false; old_enabled=false; old_unit=false
systemctl is-active --quiet "$unit" && old_active=true
systemctl is-enabled --quiet "$unit" 2>/dev/null && old_enabled=true
if [[ -e "$unit_path" ]]; then
  [[ -f "$unit_path" && ! -L "$unit_path" ]] || exit 1
  cp -a "$unit_path" "$backup"; old_unit=true
fi
printf '%s\n' "$previous" > "$base/backups/previous-release-$release_id.txt"
candidate="$release/zhongyuan-daojia-private-admin.service"
[[ ! -e "$candidate" ]] || exit 1
cat > "$candidate" <<UNIT
[Unit]
Description=Zhongyuan Daojia private production admin
After=network.target zhongyuan-daojia-api.service
Requires=zhongyuan-daojia-api.service

[Service]
Type=simple
User=zydj
Group=zydj
WorkingDirectory=$release
Environment=NODE_ENV=production
Environment=PRIVATE_ADMIN_ROOT=$release/dist
ExecStart=$service_node $release/serve-production-private-admin.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$candidate"
systemd-analyze verify "$candidate"

replace_link() {
  local target=$1 operation=$2 temporary="$base/current.$2-$release_id"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$base/current"
}
verify_release() {
  local expected=$1 pid
  pid=$(systemctl show "$unit" -p MainPID --value)
  [[ $pid =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$pid/cwd") == "$expected" ]] || return 1
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3222/ >/dev/null || return 1
  [[ $(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3222/v1/admin/catalog/services) == 401 ]] || return 1
  [[ $(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3222/v1/admin/unknown) == 404 ]] || return 1
}
wait_for_release() {
  local expected=$1
  for _ in {1..20}; do
    if verify_release "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}
activated=false
rollback() {
  trap - ERR
  local failed=0
  systemctl stop "$unit" || failed=1
  if [[ $old_unit == true ]]; then cp -a "$backup" "$unit_path" || failed=1
  else systemctl disable "$unit" >/dev/null 2>&1 || failed=1; rm -f -- "$unit_path" || failed=1; fi
  if [[ -n "$previous" ]]; then replace_link "$previous" rollback || failed=1
  else rm -f -- "$base/current" || failed=1; fi
  systemctl daemon-reload || failed=1
  if [[ $old_enabled == true ]]; then systemctl enable "$unit" >/dev/null || failed=1
  elif [[ $old_unit == true ]]; then systemctl disable "$unit" >/dev/null 2>&1 || failed=1; fi
  if [[ $old_active == true ]]; then
    systemctl restart "$unit" || failed=1
    wait_for_release "$previous" || failed=1
  fi
  (( failed == 0 ))
}
on_error() {
  local status=$?
  trap - ERR
  if [[ $activated == true ]] && ! rollback; then
    echo "CRITICAL: private admin deployment failed and rollback is incomplete" >&2; exit 70
  fi
  exit "$status"
}
trap on_error ERR
activated=true
replace_link "$release" activate
mv -Tf "$candidate" "$unit_path"
systemctl daemon-reload
systemctl restart "$unit"
wait_for_release "$release"
systemctl enable "$unit" >/dev/null
activated=false
trap - ERR
echo "Private production admin ready on loopback 3222: $release_id"
echo "Install the same release's Nginx config for trusted-private HTTPS access; public access must remain 503."

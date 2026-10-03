#!/usr/bin/env bash
# Independent, loopback-only acceptance. Never change Nginx, DNS, old business data or payment keys.
set -euo pipefail
umask 077
base=/opt/zhongyuan-daojia-acceptance
release_id=${1:?Pass the exact lowercase 40-character main commit SHA}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid deployment identity'; exit 1; }
[[ -f "$base/OWNER" && $(<"$base/OWNER") == zhongyuan-daojia-private-acceptance ]] || { echo 'Scope marker missing'; exit 1; }
release="$base/releases/$release_id"
[[ $(realpath "$release") == "$base/releases/$release_id" && -f "$release/apps/api/dist/main.js" ]] || exit 1
[[ $(<"$release/DEPLOY_COMMIT") == "$release_id" ]] || { echo 'Artifact commit mismatch'; exit 1; }
free_kib=$(df -Pk "$base" | awk 'NR==2 {print $4}')
(( free_kib > 3145728 )) || { echo 'Less than 3 GiB free; refusing new installation'; exit 1; }
for port in 3210 3212 3213; do
  if ss -lntH | awk '{print $4}' | grep -Eq ":${port}$"; then
    systemctl is-active --quiet "zhongyuan-daojia-acceptance-$([[ $port == 3210 ]] && echo api || { [[ $port == 3212 ]] && echo admin || echo h5; }).service" || { echo 'Target port belongs to another service'; exit 1; }
  fi
done
mkdir -p "$base/runtime" "$base/tooling" "$base/npm-cache" "$base/store" "$base/backups"
node_root="$base/runtime/node-v24.19.0-linux-x64"
if [[ ! -x "$node_root/bin/node" ]]; then
  cd "$base/runtime"
  curl --fail --location --connect-timeout 10 --max-time 180 -O https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
  curl --fail --location --connect-timeout 10 --max-time 30 -O https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
  grep ' node-v24.19.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check -
  tar -xJf node-v24.19.0-linux-x64.tar.xz
fi
export PATH="$node_root/bin:$base/tooling/node_modules/.bin:$PATH"
export NPM_CONFIG_CACHE="$base/npm-cache"
[[ $(node --version) == v24.19.0 ]] || exit 1
if [[ ! -x "$base/tooling/node_modules/.bin/pnpm" ]]; then npm install --prefix "$base/tooling" pnpm@11.19.0 --ignore-scripts --no-audit --no-fund; fi
[[ $(pnpm --version) == 11.19.0 ]] || exit 1
cd "$release"
pnpm install --frozen-lockfile --ignore-scripts --filter '@zydj/api...' --store-dir "$base/store"
id -u zydj-acceptance >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin zydj-acceptance
chown -R root:zydj-acceptance "$base/runtime" "$release"
chown root:zydj-acceptance "$base" "$base/releases"
chmod 0750 "$base" "$base/releases" "$release"
cd "$base"
node "$release/scripts/setup-private-acceptance.mjs"
set -a; source /etc/zhongyuan-daojia-acceptance/api.env; set +a
cd "$release"
pnpm --filter @zydj/api exec prisma generate
# Back up ONLY the independent acceptance DB before every release migration.
backup="$base/backups/database-before-$release_id-$(date -u +%Y%m%dT%H%M%S).dump"
[[ ! -e "$backup" && ! -e "$backup.partial" ]] || { echo 'Own backup target already exists; inspect before retrying'; exit 1; }
runuser -u postgres -- pg_dump -Fc -d zydj_acceptance > "$backup.partial"
pg_restore --list "$backup.partial" >/dev/null
mv "$backup.partial" "$backup"
pnpm --filter @zydj/api exec prisma migrate deploy
pnpm --filter @zydj/api exec prisma migrate status
# This database is a new private acceptance DB, never the existing business DB.
SEED_DEVELOPMENT_IDENTITIES=false pnpm --filter @zydj/api exec tsx prisma/seed.ts
chown -R root:zydj-acceptance "$release"
chmod -R g+rX "$release" "$base/runtime"
if [[ -L "$base/current" ]]; then readlink "$base/current" > "$base/backups/previous-release-$release_id.txt"; fi
[[ ! -e "$base/current" || -L "$base/current" ]] || { echo 'Foreign current path; refusing'; exit 1; }
ln -sfn "$release" "$base/current"
systemctl daemon-reload
systemctl enable --now zhongyuan-daojia-acceptance-{api,admin,h5}.service
systemctl restart zhongyuan-daojia-acceptance-{api,admin,h5}.service
for n in {1..15}; do if curl --fail --silent http://127.0.0.1:3210/v1/health; then break; fi; sleep 1; done
curl --fail --silent http://127.0.0.1:3210/v1/health
curl --fail --silent --output /dev/null http://127.0.0.1:3212/
curl --fail --silent --output /dev/null http://127.0.0.1:3213/
ss -lntH | awk '$4 ~ /:(3210|3212|3213)$/ {print $4}'
df -h "$base"
echo 'Private acceptance only; production gates and public site unchanged'

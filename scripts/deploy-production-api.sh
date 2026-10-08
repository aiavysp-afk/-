#!/usr/bin/env bash
# Deploy one exact public main commit to the production API and technician H5.
set -euo pipefail
umask 077

base=/opt/zhongyuan-daojia
web_base=/var/www/zhongyuan-daojia-technician
release_id=${1:?Pass the exact lowercase 40-character main commit SHA}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ -L "$base/current" && -d "$base/releases" && -d "$base/backups" ]] || exit 1
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
runuser -u postgres -- pg_dump -Fc -d zhongyuan_daojia > "$backup.partial"
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
chown -R root:zydj "$release"
chmod -R g+rX "$release"
ln -sfn "$web_release" "$web_base/current"
ln -sfn "$release" "$base/current"
if ! systemctl restart zhongyuan-daojia-api.service; then
  ln -sfn "$previous" "$base/current"
  if [[ -n "$previous_web" ]]; then
    ln -sfn "$previous_web" "$web_base/current"
  else
    rm -f "$web_base/current"
  fi
  systemctl restart zhongyuan-daojia-api.service
  exit 1
fi
for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:3220/v1/health >/dev/null; then
    echo "Production API release active: $release_id"
    exit 0
  fi
  sleep 1
done
ln -sfn "$previous" "$base/current"
if [[ -n "$previous_web" ]]; then
  ln -sfn "$previous_web" "$web_base/current"
else
  rm -f "$web_base/current"
fi
systemctl restart zhongyuan-daojia-api.service
echo "Health check failed; application symlink rolled back"
exit 1

#!/usr/bin/env bash
# Install the exact production Nginx vhost from one public main commit.
# Pass the currently enabled vhost path explicitly so this script never guesses.
set -euo pipefail
umask 077

base=/opt/zhongyuan-daojia
release_id=${1:?Pass the exact lowercase 40-character main commit SHA}
target_input=${2:?Pass the exact active Nginx vhost path}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || exit 1
command -v flock >/dev/null
exec 8>"$base/nginx-deploy.lock"
flock -n 8 || { echo "Another Nginx deployment is already running"; exit 1; }

target=$(readlink -f -- "$target_input")
[[ $target == /etc/nginx/* && -f $target ]] || {
  echo "Refusing a non-Nginx or missing target"
  exit 1
}

current_nginx_dump=$(nginx -T 2>&1) || {
  echo "Refusing to deploy while the active Nginx configuration cannot be read"
  exit 1
}
active_target=false
while IFS= read -r loaded_vhost; do
  [[ -n $loaded_vhost ]] || continue
  loaded_target=$(readlink -f -- "$loaded_vhost") || continue
  if [[ $loaded_target == "$target" ]]; then
    active_target=true
    break
  fi
done < <(
  printf '%s\n' "$current_nginx_dump" |
    awk '
      function emit() {
        if (file != "" && api && admin) print file
      }
      /^# configuration file / {
        emit()
        file = $4
        sub(/:$/, "", file)
        api = 0
        admin = 0
        next
      }
      /^[[:space:]]*server_name[[:space:]][^;]*api\.mtsc\.top([[:space:];]|$)/ { api = 1 }
      /^[[:space:]]*server_name[[:space:]][^;]*admin\.mtsc\.top([[:space:];]|$)/ { admin = 1 }
      END { emit() }
    '
)
[[ $active_target == true ]] || {
  echo "Refusing a target that is not the loaded api/admin production vhost"
  exit 1
}

target_dir=$(dirname "$target")
target_name=$(basename "$target")
candidate="$target_dir/.$target_name.candidate-$release_id"
backup="$base/backups/nginx-$target_name-before-$release_id-$(date -u +%Y%m%dT%H%M%S)"
[[ ! -e $candidate && ! -e $backup ]] || {
  echo "Candidate or backup path already exists"
  exit 1
}

curl --fail --location --connect-timeout 10 --max-time 60 \
  "https://raw.githubusercontent.com/aiavysp-afk/-/$release_id/infra/nginx.production.conf" \
  --output "$candidate"
for marker in \
  'server_name api.mtsc.top;' \
  'server_name admin.mtsc.top;' \
  'location ~ ^/v1/customer-center' \
  'location = /v1/technician-invitations/claim' \
  'if ($zydj_admin_request_denied) { return 403; }' \
  'return 503 maintenance;'; do
  grep -Fq "$marker" "$candidate" || {
    echo "Downloaded Nginx config is missing a release marker"
    exit 1
  }
done

cp -a -- "$target" "$backup"
chown --reference="$target" "$candidate"
chmod --reference="$target" "$candidate"

validate_nginx() {
  local output
  if ! output=$(nginx -t 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi
  if [[ $output == *"conflicting server name"* ]]; then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

restore_nginx() {
  local failed=0
  cp -a -- "$backup" "$candidate" || failed=1
  mv -Tf -- "$candidate" "$target" || failed=1
  validate_nginx || failed=1
  systemctl reload nginx.service || failed=1
  (( failed == 0 ))
}

activated=false
on_error() {
  local status=$?
  trap - ERR
  if [[ $activated == true ]] && ! restore_nginx; then
    echo "CRITICAL: Nginx deployment failed and rollback is incomplete" >&2
    exit 70
  fi
  exit "$status"
}
trap on_error ERR

activated=true
mv -Tf -- "$candidate" "$target"
validate_nginx
systemctl reload nginx.service
systemctl is-active --quiet nginx.service

api_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve api.mtsc.top:443:127.0.0.1 \
  https://api.mtsc.top/v1/health)
admin_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve admin.mtsc.top:443:127.0.0.1 \
  https://admin.mtsc.top/)
customer_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve api.mtsc.top:443:127.0.0.1 \
  https://api.mtsc.top/v1/customer-center)
[[ $api_status == 200 && $admin_status == 503 && $customer_status == 401 ]]
curl --silent --show-error --head \
  --resolve api.mtsc.top:443:127.0.0.1 \
  https://api.mtsc.top/v1/health |
  tr -d '\r' |
  grep -qi '^strict-transport-security:'

activated=false
trap - ERR
echo "Production Nginx config active: $release_id"

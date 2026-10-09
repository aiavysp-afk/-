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

release_config="$base/releases/$release_id/infra/nginx.production.conf"
if [[ -f $release_config ]]; then
  # The API deployment has already downloaded and verified this exact immutable
  # release. Prefer it so a transient raw.githubusercontent.com outage cannot
  # block the gateway step after the application has been activated.
  cp -- "$release_config" "$candidate"
else
  curl --fail --location --connect-timeout 10 --max-time 60 \
    "https://raw.githubusercontent.com/aiavysp-afk/-/$release_id/infra/nginx.production.conf" \
    --output "$candidate"
fi
for marker in \
  'server_name api.mtsc.top;' \
  'server_name admin.mtsc.top;' \
  'location ~ ^/v1/customer-center' \
  'first-recharge-reward/claim' \
  'payment-intent|friend-payment' \
  '/v1/friend-payments/' \
  'location = /v1/payments/notifications' \
  'location = /v1/customer-center/newcomer-coupons' \
  'location = /v1/technician-invitations/claim' \
  'location ~ ^/v1/admin/organizations/[^/]+/customer-center/wallet-ledger$ {' \
  'if ($zydj_admin_request_denied) { return 403; }' \
  'if ($zydj_admin_network_allowed = 0) { return 503 maintenance; }' \
  'proxy_pass http://127.0.0.1:3222;'; do
  grep -Fq "$marker" "$candidate" || {
    echo "Downloaded Nginx config is missing a release marker"
    exit 1
  }
done

# Deploy the production-only loopback admin adapter first. Do not install a
# gateway that routes private staff traffic to an absent or acceptance service.
systemctl is-active --quiet zhongyuan-daojia-private-admin.service
admin_release="/opt/zhongyuan-daojia-admin/releases/$release_id"
[[ $(readlink -f /opt/zhongyuan-daojia-admin/current) == "$admin_release" ]]
[[ -f "$admin_release/DEPLOY_COMMIT" && $(<"$admin_release/DEPLOY_COMMIT") == "$release_id" ]]
admin_pid=$(systemctl show zhongyuan-daojia-private-admin.service -p MainPID --value)
[[ $admin_pid =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$admin_pid/cwd") == "$admin_release" ]]
[[ $(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:3222/) == 200 ]]
[[ $(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:3222/v1/admin/catalog/services) == 401 ]]

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

# Private gateway probe helpers. Reload sends a signal; a new worker may not be
# ready when that command returns. Bound convergence, never accept old statuses.
private_gateway_status() {
  local host=$1 path=$2 remaining=$((private_gateway_deadline - SECONDS))
  if (( remaining <= 0 )); then printf '%s' deadline-expired; return 0; fi
  local timeout=2
  (( remaining >= timeout )) || timeout=$remaining
  curl --silent --show-error --connect-timeout 1 --max-time "$timeout" \
    --http1.1 --header 'Connection: close' --noproxy '*' \
    --output /dev/null --write-out '%{http_code}' \
    --resolve "$host:443:127.0.0.1" "https://$host$path"
}

verify_private_gateway() {
  api_status=not-probed; admin_status=not-probed; customer_status=not-probed
  private_catalog_status=not-probed; private_unknown_status=not-probed
  api_status=$(private_gateway_status api.mtsc.top /v1/health) || api_status=transport-error
  [[ $api_status == 200 ]] || return 1
  admin_status=$(private_gateway_status admin.mtsc.top /) || admin_status=transport-error
  [[ $admin_status == 200 ]] || return 1
  customer_status=$(private_gateway_status api.mtsc.top /v1/customer-center) || customer_status=transport-error
  [[ $customer_status == 401 ]] || return 1
  private_catalog_status=$(private_gateway_status admin.mtsc.top /v1/admin/catalog/services) || private_catalog_status=transport-error
  [[ $private_catalog_status == 401 ]] || return 1
  private_unknown_status=$(private_gateway_status admin.mtsc.top /v1/admin/unknown) || private_unknown_status=transport-error
  [[ $private_unknown_status == 404 ]]
}

wait_for_private_gateway() {
  local private_gateway_deadline=$((SECONDS + 30)) attempts=0
  while (( attempts < 10 && SECONDS < private_gateway_deadline )); do
    attempts=$((attempts + 1))
    if verify_private_gateway; then return 0; fi
    if (( attempts < 10 && SECONDS < private_gateway_deadline )); then sleep 1; fi
  done
  printf 'Private gateway did not converge: API=%s admin=%s customer=%s catalog=%s unknown=%s\n' \
    "$api_status" "$admin_status" "$customer_status" "$private_catalog_status" "$private_unknown_status" >&2
  return 1
}
# End private gateway probe helpers.

# Failure remains a top-level error, invoking the existing exact-vhost rollback.
wait_for_private_gateway
# An actual public source can additionally prove the maintenance gate here.
# NAT/EIP hosts often have only private interfaces: do not mistake a private
# request for a public proof. An independent external client must verify 503
# before the operator accepts this release. Never disable TLS verification.
public_ipv4=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[[ $public_ipv4 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
if [[ $public_ipv4 == 127.* || $public_ipv4 == 10.* || $public_ipv4 == 192.168.* || $public_ipv4 =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]; then
  echo "Private/NAT source detected: independent external verification of public admin 503 is required"
else
  public_admin_status=$(curl --silent --show-error --max-time 10 --interface "$public_ipv4" --output /dev/null --write-out '%{http_code}' \
    --resolve "admin.mtsc.top:443:$public_ipv4" https://admin.mtsc.top/)
  [[ $public_admin_status == 503 ]]
fi
for benefit_route in newcomer-coupons wallet/first-recharge-reward/claim; do
  benefit_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --resolve api.mtsc.top:443:127.0.0.1 --request POST \
    --header 'Content-Type: application/json' --data '{}' \
    "https://api.mtsc.top/v1/customer-center/$benefit_route")
  [[ $benefit_status == 401 ]]
done
# Probe both gateway paths with no identity; this creates no ledger mutation.
wallet_ledger_route=/v1/admin/organizations/probe/customer-center/wallet-ledger
for wallet_ledger_host in api.mtsc.top admin.mtsc.top; do
  wallet_ledger_status=$(curl --silent --show-error --connect-timeout 2 --max-time 10 \
    --request GET --output /dev/null --write-out '%{http_code}' \
    --resolve "$wallet_ledger_host:443:127.0.0.1" "https://$wallet_ledger_host$wallet_ledger_route")
  [[ $wallet_ledger_status == 401 ]]
done
# Invitations never bypass login; no live transaction is created by these probes.
friend_probe_token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
for route in "friend-payments/$friend_probe_token" "friend-payments/$friend_probe_token/payment-intent" payments/notifications; do
  friend_status=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --resolve api.mtsc.top:443:127.0.0.1 "https://api.mtsc.top/v1/$route")
  [[ $friend_status == 401 ]]
done
for route in "orders/probe/friend-payment" "friend-payments/$friend_probe_token/payment-intent" "friend-payments/$friend_probe_token/reconcile"; do
  friend_status=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --resolve api.mtsc.top:443:127.0.0.1 --request POST \
    --header 'Content-Type: application/json' --data '{}' "https://api.mtsc.top/v1/$route")
  [[ $friend_status == 401 ]]
done
curl --silent --show-error --head \
  --resolve api.mtsc.top:443:127.0.0.1 \
  https://api.mtsc.top/v1/health |
  tr -d '\r' |
  grep -qi '^strict-transport-security:'

activated=false
trap - ERR
echo "Production Nginx config active: $release_id"

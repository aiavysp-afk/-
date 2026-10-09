#!/usr/bin/env bash
# Update only the two technician image CSP directives in the loaded root vhost.
# Never run the legacy-retirement script to publish this narrow configuration fix.
set -euo pipefail
umask 077

base=/opt/zhongyuan-daojia
web_base=/var/www/zhongyuan-daojia-technician
release_id=${1:?Pass the exact lowercase 40-character deployed commit SHA}
target_input=${2:?Pass the exact currently loaded mtsc.top vhost path}
[[ $EUID == 0 && $release_id =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ -d "$base/backups" && ! -L "$base/backups" ]] || exit 1
[[ $(readlink -f "$web_base/current") == "$web_base/releases/$release_id" ]]
[[ -r "$web_base/current/index.html" ]]
command -v flock >/dev/null
exec 8>"$base/nginx-deploy.lock"
flock -n 8 || { echo "Another Nginx deployment is already running"; exit 1; }

target=$(readlink -f -- "$target_input")
[[ $target == /etc/nginx/* && -f $target ]] || {
  echo "Refusing a non-Nginx or missing target" >&2; exit 1;
}
current_nginx_dump=$(nginx -T 2>&1) || exit 1
active_target=false
while IFS= read -r loaded_vhost; do
  [[ -n $loaded_vhost ]] || continue
  if [[ $(readlink -f -- "$loaded_vhost") == "$target" ]]; then active_target=true; break; fi
done < <(printf '%s\n' "$current_nginx_dump" | awk '
  function emit() { if (file != "" && root_host) print file }
  /^# configuration file / { emit(); file=$4; sub(/:$/, "", file); root_host=0; next }
  /^[[:space:]]*server_name[[:space:]][^;]*[[:space:]]mtsc\.top([[:space:];]|$)/ { root_host=1 }
  /^[[:space:]]*server_name[[:space:]]mtsc\.top([[:space:];]|$)/ { root_host=1 }
  END { emit() }
')
[[ $active_target == true ]] || { echo "Refusing a vhost that is not loaded for mtsc.top" >&2; exit 1; }
for marker in \
  'alias /var/www/zhongyuan-daojia-technician/current/index.html;' \
  'alias /var/www/zhongyuan-daojia-technician/current/assets/;' \
  'location / { error_page 503 /maintenance.html; return 503; }'; do
  grep -Fq "$marker" "$target" || { echo "Root maintenance boundary differs; refusing deployment" >&2; exit 1; }
done
printf '%s\n' "$current_nginx_dump" | grep -F 'if ($zydj_admin_network_allowed = 0) { return 503 maintenance; }' >/dev/null

old_policy="default-src 'self'; connect-src https://api.mtsc.top; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
new_policy="default-src 'self'; connect-src https://api.mtsc.top; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
target_dir=$(dirname "$target")
target_name=$(basename "$target")
candidate="$target_dir/.$target_name.technician-candidate-$release_id"
backup="$base/backups/nginx-technician-$target_name-before-$release_id-$(date -u +%Y%m%dT%H%M%S)"
[[ ! -e $candidate && ! -L $candidate && ! -e $backup && ! -L $backup ]] || exit 1
cleanup_candidate() {
  if [[ -f $candidate && ! -L $candidate ]]; then rm -f -- "$candidate"; fi
}
trap cleanup_candidate EXIT

# Technician candidate helper: preserve other directives and require two exact policies.
build_technician_candidate() {
  awk -v old="$old_policy" -v updated="$new_policy" '
    BEGIN { old_directive="add_header Content-Security-Policy \"" old "\" always;"; new_directive="add_header Content-Security-Policy \"" updated "\" always;" }
    { line=$0; sub(/^[[:space:]]*/, "", line)
      if (line == old_directive || line == new_directive) {
        prefix=substr($0, 1, length($0)-length(line)); print prefix new_directive; count++
      } else print
    }
    END { if (count != 2) { print "Expected exactly two unchanged technician CSP directives" > "/dev/stderr"; exit 1 } }
  ' "$target" > "$candidate"
}
# End technician candidate helper.

validate_nginx() {
  local output
  if ! output=$(nginx -t 2>&1); then printf '%s\n' "$output" >&2; return 1; fi
  [[ $output != *"conflicting server name"* ]] || { printf '%s\n' "$output" >&2; return 1; }
}
restore_technician_nginx() {
  cp -a -- "$backup" "$candidate" || return 1
  cmp -s -- "$backup" "$candidate" || return 1
  mv -Tf -- "$candidate" "$target" || return 1
  cmp -s -- "$backup" "$target" || return 1
  validate_nginx || return 1
  systemctl reload nginx.service || return 1
  systemctl is-active --quiet nginx.service
}

# Technician reload probe helpers: require the new image policy and existing maintenance gates.
technician_gateway_response() {
  local host=$1 path=$2 mode=$3 remaining=$((technician_gateway_deadline - SECONDS))
  if (( remaining <= 0 )); then return 1; fi
  local timeout=2
  (( remaining >= timeout )) || timeout=$remaining
  if [[ $mode == headers ]]; then
    curl --silent --show-error --connect-timeout 1 --max-time "$timeout" \
      --http1.1 --header 'Connection: close' --noproxy '*' --dump-header - --output /dev/null \
      --resolve "$host:443:127.0.0.1" "https://$host$path" | tr -d '\r'
  else
    curl --silent --show-error --connect-timeout 1 --max-time "$timeout" \
      --http1.1 --header 'Connection: close' --noproxy '*' --output /dev/null --write-out '%{http_code}' \
      --resolve "$host:443:127.0.0.1" "https://$host$path"
  fi
}
verify_technician_gateway() {
  local headers main_status admin_status
  headers=$(technician_gateway_response mtsc.top /technician/ headers) || return 1
  printf '%s\n' "$headers" | grep -Eq '^HTTP/[0-9.]+ 200([[:space:]]|$)' || return 1
  printf '%s\n' "$headers" | grep -Fxi "Content-Security-Policy: $new_policy" >/dev/null || return 1
  main_status=$(technician_gateway_response mtsc.top / status) || return 1
  [[ $main_status == 503 ]] || return 1
  admin_status=$(technician_gateway_response admin.mtsc.top / status) || return 1
  [[ $admin_status == 200 ]]
}
wait_for_technician_gateway() {
  local technician_gateway_deadline=$((SECONDS + 30)) attempts=0
  while (( attempts < 10 && SECONDS < technician_gateway_deadline )); do
    attempts=$((attempts + 1))
    if verify_technician_gateway; then return 0; fi
    if (( attempts < 10 && SECONDS < technician_gateway_deadline )); then sleep 1; fi
  done
  echo "Technician CSP and maintenance probes did not converge" >&2
  return 1
}
# End technician reload probe helpers.

activated=false
on_error() {
  local status=$?
  trap - ERR
  if [[ $activated == true ]] && ! restore_technician_nginx; then
    echo "CRITICAL: technician Nginx deployment failed and rollback is incomplete" >&2
    exit 70
  fi
  exit "$status"
}
trap on_error ERR
build_technician_candidate
if cmp -s -- "$candidate" "$target"; then
  rm -f -- "$candidate"
  validate_nginx
  wait_for_technician_gateway
  echo "Technician image policy already active: $release_id"
  exit 0
fi
cp -a -- "$target" "$backup"
chown --reference="$target" "$candidate"
chmod --reference="$target" "$candidate"
# The exact target must still equal the protected backup before replacement.
cmp -s -- "$backup" "$target"
activated=true
mv -Tf -- "$candidate" "$target"
validate_nginx
systemctl reload nginx.service
systemctl is-active --quiet nginx.service
wait_for_technician_gateway
activated=false
trap - ERR
echo "Technician image policy active: $release_id; backup retained at $backup"
echo "Public admin remains private; an independent external client must still confirm admin.mtsc.top returns 503."

#!/usr/bin/env bash
set -uo pipefail

echo "== host =="
printf 'hostname=%s\n' "$(hostname)"
printf 'os=%s\n' "$(. /etc/os-release 2>/dev/null; printf '%s %s' "${NAME:-unknown}" "${VERSION_ID:-unknown}")"
printf 'utc=%s\n' "$(date -u +%FT%TZ)"

roots=(/www /opt /srv /var/www /root /home)
existing_roots=()
for root in "${roots[@]}"; do
  [[ -d "$root" ]] && existing_roots+=("$root")
done

echo "== runtime =="
if command -v docker >/dev/null 2>&1; then
  echo "docker=present"
  docker ps --format 'container={{.Names}} image={{.Image}}' 2>/dev/null || true
  while IFS= read -r container; do
    [[ -z "$container" ]] && continue
    names="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
      | sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' \
      | grep -Ei '(WECHAT|WEIXIN|WX_|MCH|API.*V3|V3.*KEY|PAY.*CERT|PRIVATE.*KEY)' \
      | sort -u | paste -sd, - || true)"
    [[ -n "$names" ]] && printf 'container_env_names[%s]=%s\n' "$container" "$names"
  done < <(docker ps --format '{{.Names}}' 2>/dev/null)
else
  echo "docker=absent"
fi

echo "== nginx routes =="
if command -v nginx >/dev/null 2>&1; then
  echo 'nginx=present'
  printf 'matching_server_name_count=%s\n' \
    "$(nginx -T 2>/dev/null | grep -Ec 'server_name.*mtsc\.top' || true)"
else
  echo "nginx=absent"
fi

echo "== candidate config files =="
candidate_list="$(mktemp)"
trap 'rm -f "$candidate_list"' EXIT
for root in "${existing_roots[@]}"; do
  find "$root" -xdev -maxdepth 9 \
    \( -type d \( -name node_modules -o -name .git -o -name cache -o -name .cache -o -name logs -o -name backups -o -name backup \) -prune \) -o \
    \( -type f -size -3M \
       \( -name '.env' -o -name '.env.*' -o -iname '*compose*.yml' -o -iname '*compose*.yaml' \
          -o -iname '*.service' -o -iname '*.conf' -o -iname 'ecosystem*.js' -o -iname 'ecosystem*.cjs' \
          -o -iname 'config*.json' -o -iname 'config*.yml' -o -iname 'config*.yaml' \) -print0 \) 2>/dev/null \
    | while IFS= read -r -d '' file; do
        if grep -IqiE '(WECHAT|WEIXIN|WX_|MCH(_ID)?|API.?V3|wechatpay|apiclient|PAY.*CERT|PRIVATE.*KEY)' "$file" 2>/dev/null; then
          printf '%s\n' "$file"
        fi
      done
done | sort -u > "$candidate_list"
printf 'candidate_config_count=%s\n' "$(wc -l < "$candidate_list" | tr -d ' ')"

echo "== matching key names only =="
config_index=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  config_index=$((config_index + 1))
  keys="$(sed -nE 's/^[[:space:]"'"'"'-]*([A-Za-z_][A-Za-z0-9_.-]*)["'"'"']?[[:space:]]*[:=].*/\1/p' "$file" 2>/dev/null \
    | grep -Ei '(WECHAT|WEIXIN|WX_|MCH|API.*V3|V3.*KEY|PAY.*CERT|PRIVATE.*KEY)' \
    | sort -u | paste -sd, - || true)"
  [[ -n "$keys" ]] && printf 'keys[config_%s]=%s\n' "$config_index" "$keys"
done < "$candidate_list"

echo "== certificate and key file paths =="
asset_list="$(mktemp)"
trap 'rm -f "$candidate_list" "$asset_list"' EXIT
for root in "${existing_roots[@]}"; do
  find "$root" -xdev -maxdepth 9 \
    \( -type d \( -name node_modules -o -name .git -o -name cache -o -name .cache -o -name logs -o -name backups -o -name backup \) -prune \) -o \
    \( -type f -size -5M \
       \( -iname '*apiclient*.pem' -o -iname '*apiclient*.p12' -o -iname '*wechat*cert*.pem' \
          -o -iname '*wechat*key*.pem' -o -iname '*wechatpay*.pem' -o -iname '*mch*cert*.pem' \
          -o -iname '*mch*key*.pem' -o -iname 'platform_cert*.pem' \) -print \) 2>/dev/null
done | sort -u > "$asset_list"
printf 'crypto_asset_count=%s\n' "$(wc -l < "$asset_list" | tr -d ' ')"

asset_index=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  asset_index=$((asset_index + 1))
  stat -c "asset[$asset_index] owner=%U:%G mode=%a bytes=%s" "$file" 2>/dev/null || true
  if command -v openssl >/dev/null 2>&1 && openssl x509 -in "$file" -noout >/dev/null 2>&1; then
    serial="$(openssl x509 -in "$file" -noout -serial 2>/dev/null | cut -d= -f2)"
    printf 'x509[asset_%s] serial_present=%s serial_length=%s\n' \
      "$asset_index" "$([[ -n "$serial" ]] && echo yes || echo no)" "${#serial}"
    openssl x509 -in "$file" -noout -dates 2>/dev/null \
      | sed "s#^#x509[asset_$asset_index] #"
  elif command -v openssl >/dev/null 2>&1 && openssl pkey -in "$file" -noout -check >/dev/null 2>&1; then
    printf 'private_key[asset_%s]=valid\n' "$asset_index"
  else
    printf 'asset_type[asset_%s]=unverified_or_encrypted\n' "$asset_index"
  fi
done < "$asset_list"

echo "== sanitized value facts =="
config_index=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  config_index=$((config_index + 1))
  while IFS= read -r line; do
    name="${line%%=*}"
    value="${line#*=}"
    name="$(printf '%s' "$name" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/[[:space:]]+$//')"
    value="$(printf '%s' "$value" | sed -E 's/^[[:space:]"'"'"']+//; s/[[:space:]"'"'"']+$//')"
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    if [[ "$upper" =~ (WECHAT|WEIXIN|WX_|MCH|API.*V3|V3.*KEY|PAY.*CERT|PRIVATE.*KEY) ]]; then
      printf 'value_fact[config_%s:%s]=present length=%s\n' "$config_index" "$name" "${#value}"
    fi
  done < <(grep -IE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$file" 2>/dev/null || true)
done < "$candidate_list"

echo "== audit complete =="

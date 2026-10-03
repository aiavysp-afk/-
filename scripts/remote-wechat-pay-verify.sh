#!/usr/bin/env bash
set -euo pipefail

target_appid='wxab76ea213eb6d01a'
service='jingxiang-api.service'

env_value() {
  local file="$1" key="$2" raw
  raw="$(grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | sed -E 's/^[^=]*=//' || true)"
  raw="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  printf '%s' "$raw"
}

env_value_any() {
  local file="$1" primary="$2" fallback="$3" value
  value="$(env_value "$file" "$primary")"
  [[ -n "$value" ]] || value="$(env_value "$file" "$fallback")"
  printf '%s' "$value"
}

sanitize_url() {
  printf '%s' "$1" | sed -E 's|(https?://)[^/@]+@|\1|; s|[?#].*$||'
}

echo '== active service =='
systemctl is-active "$service" 2>/dev/null | sed 's/^/service_state=/' || true
systemctl show "$service" --no-pager -p ActiveState -p SubState 2>/dev/null || true
if [[ -n "$(readlink -f /opt/jingxiang-platform/current 2>/dev/null || true)" ]]; then
  echo 'current_release_detected=yes'
else
  echo 'current_release_detected=no'
fi

env_file=''
for candidate in \
  /opt/jingxiang-platform/shared/.env.production \
  /opt/jingxiang-platform/current/.env.production \
  /opt/jingxiang-platform/current/.env; do
  if [[ -f "$candidate" ]]; then env_file="$(readlink -f "$candidate")"; break; fi
done

if [[ -z "$env_file" ]]; then
  echo 'env_file=not_found'
  exit 2
fi

echo 'env_file_detected=yes'
stat -c 'env_owner=%U:%G env_mode=%a env_bytes=%s' "$env_file"

appid="$(env_value_any "$env_file" WECHAT_MINIAPP_APP_ID WECHAT_APPID)"
mchid="$(env_value_any "$env_file" WECHAT_MCH_ID WECHAT_MCHID)"
mch_serial="$(env_value_any "$env_file" WECHAT_PAY_MERCHANT_SERIAL_NO WECHAT_MCH_SERIAL_NO)"
api_v3="$(env_value_any "$env_file" WECHAT_PAY_API_V3_KEY WECHAT_API_V3_KEY)"
private_key="$(env_value_any "$env_file" WECHAT_PAY_PRIVATE_KEY_PATH WECHAT_PRIVATE_KEY_PATH)"
merchant_cert="$(env_value "$env_file" WECHAT_PAY_MERCHANT_CERT_PATH)"
platform_serial="$(env_value_any "$env_file" WECHAT_PAY_PUBLIC_KEY_ID WECHAT_PLATFORM_SERIAL_NO)"
platform_cert="$(env_value_any "$env_file" WECHAT_PAY_PUBLIC_KEY_PATH WECHAT_PLATFORM_CERT_PATH)"
if [[ -z "$platform_cert" ]]; then
  platform_cert="$(env_value "$env_file" WECHAT_PAY_PLATFORM_CERT_PATH)"
fi
notify_url="$(env_value "$env_file" WECHAT_NOTIFY_URL)"
refund_notify_url="$(env_value "$env_file" WECHAT_REFUND_NOTIFY_URL)"

echo '== sanitized configuration =='
printf 'appid_present=%s appid_matches_target=%s\n' \
  "$([[ -n "$appid" ]] && echo yes || echo no)" \
  "$([[ "$appid" == "$target_appid" ]] && echo yes || echo no)"
printf 'mchid_present=%s mchid_length=%s\n' \
  "$([[ -n "$mchid" ]] && echo yes || echo no)" "${#mchid}"
printf 'api_v3_present=%s api_v3_length=%s\n' \
  "$([[ -n "$api_v3" ]] && echo yes || echo no)" "${#api_v3}"
printf 'merchant_serial_present=%s merchant_serial_length=%s\n' \
  "$([[ -n "$mch_serial" ]] && echo yes || echo no)" "${#mch_serial}"
printf 'platform_serial_present=%s platform_serial_length=%s platform_public_key_id_format=%s\n' \
  "$([[ -n "$platform_serial" ]] && echo yes || echo no)" "${#platform_serial}" \
  "$([[ "$platform_serial" == PUB_KEY_ID_* ]] && echo yes || echo no)"
printf 'notify_url=%s\nrefund_notify_url=%s\n' "$(sanitize_url "$notify_url")" "$(sanitize_url "$refund_notify_url")"

echo '== key and certificate validation =='
printf 'private_key_path_configured=%s\n' "$([[ -n "$private_key" ]] && echo yes || echo no)"
if [[ -f "$private_key" ]]; then
  stat -c 'private_key_owner=%U:%G private_key_mode=%a private_key_bytes=%s' "$private_key"
  if openssl pkey -in "$private_key" -noout -check >/dev/null 2>&1; then
    echo 'private_key_valid=yes'
  else
    echo 'private_key_valid=no_or_encrypted'
  fi
else
  echo 'private_key_exists=no'
fi

if [[ -z "$merchant_cert" && -n "$private_key" ]]; then
  merchant_cert="$(dirname "$private_key")/apiclient_cert.pem"
fi
printf 'merchant_cert_derived=%s\n' "$([[ -n "$private_key" ]] && echo yes || echo no)"
if [[ -f "$merchant_cert" ]] && openssl x509 -in "$merchant_cert" -noout >/dev/null 2>&1; then
  cert_serial="$(openssl x509 -in "$merchant_cert" -noout -serial | cut -d= -f2 | tr '[:lower:]' '[:upper:]')"
  config_serial="$(printf '%s' "$mch_serial" | tr '[:lower:]' '[:upper:]')"
  cert_pub_fingerprint="$(openssl x509 -in "$merchant_cert" -pubkey -noout | openssl sha256 | awk '{print $NF}')"
  key_pub_fingerprint="$(openssl pkey -in "$private_key" -pubout 2>/dev/null | openssl sha256 | awk '{print $NF}')"
  stat -c 'merchant_cert_owner=%U:%G merchant_cert_mode=%a merchant_cert_bytes=%s' "$merchant_cert"
  printf 'merchant_cert_valid=yes merchant_serial_matches_config=%s merchant_key_matches_cert=%s\n' \
    "$([[ "$cert_serial" == "$config_serial" ]] && echo yes || echo no)" \
    "$([[ "$cert_pub_fingerprint" == "$key_pub_fingerprint" ]] && echo yes || echo no)"
  openssl x509 -in "$merchant_cert" -noout -dates | sed 's/^/merchant_cert_/'
else
  echo 'merchant_cert_valid=no_or_missing'
fi

printf 'platform_key_path_configured=%s\n' "$([[ -n "$platform_cert" ]] && echo yes || echo no)"
if [[ -f "$platform_cert" ]]; then
  stat -c 'platform_cert_owner=%U:%G platform_cert_mode=%a platform_cert_bytes=%s' "$platform_cert"
  if openssl x509 -in "$platform_cert" -noout >/dev/null 2>&1; then
    cert_serial="$(openssl x509 -in "$platform_cert" -noout -serial | cut -d= -f2 | tr '[:lower:]' '[:upper:]')"
    config_serial="$(printf '%s' "$platform_serial" | tr '[:lower:]' '[:upper:]')"
    printf 'platform_cert_valid=yes platform_serial_matches_config=%s\n' "$([[ "$cert_serial" == "$config_serial" ]] && echo yes || echo no)"
    openssl x509 -in "$platform_cert" -noout -dates | sed 's/^/platform_cert_/'
  elif openssl pkey -pubin -in "$platform_cert" -noout >/dev/null 2>&1; then
    printf 'wechat_platform_mode=public_key platform_public_key_valid=yes platform_public_key_id_format=%s\n' \
      "$([[ "$platform_serial" == PUB_KEY_ID_* ]] && echo yes || echo no)"
  else
    echo 'platform_key_or_cert_valid=no'
  fi
else
  echo 'platform_cert_exists=no'
fi

echo '== verification complete =='

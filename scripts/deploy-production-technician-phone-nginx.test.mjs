import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(new URL("./deploy-production-nginx.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = deploy.indexOf("# Technician phone gateway probe helpers.");
const end = deploy.indexOf("# End technician phone gateway probe helpers.", start);
assert.ok(start >= 0 && end > start);
const helpers = deploy.slice(start, end);
const rollback = deploy.slice(deploy.indexOf("on_error() {"), deploy.indexOf("\ntrap on_error ERR"));
const bash = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/bash";

function simulate(fault) {
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input: `set -euo pipefail
fault=${fault}
curl() {
  local method=GET data= previous= argument url="\${@: -1}" path=
  for argument in "$@"; do
    [[ $previous != --request ]] || method=$argument
    [[ $previous != --data ]] || data=$argument
    [[ $argument != --head ]] || method=HEAD
    case "$argument" in *Authorization*|*Cookie*|*Bearer*|--insecure) return 90 ;; esac
    previous=$argument
  done
  [[ $method != POST && $method != PATCH || $data == '{}' ]] || return 90
  [[ $fault != transport ]] || return 7
  path=\${url#https://api.mtsc.top}
  printf 'PROBE %s %s\n' "$method" "$path" >&2
  case "$method:$path" in
    GET:/v1/auth/technician-phone/capabilities) printf 200 ;;
    POST:/v1/auth/technician-phone/sms/request|POST:/v1/auth/technician-phone/sms/confirm)
      if [[ $fault == schema ]]; then printf 503; else printf 400; fi ;;
    GET:/v1/technician/phone-onboarding/status|POST:/v1/technician/phone-onboarding/register|PATCH:/v1/technician/phone-onboarding/profile|POST:/v1/technician/phone-onboarding/photos|POST:/v1/technician/phone-onboarding/documents|POST:/v1/technician/phone-onboarding/submit)
      if [[ $fault == missing ]]; then printf 404
      elif [[ $fault == anonymous ]]; then printf 200
      else printf 401; fi ;;
    HEAD:*|DELETE:*) if [[ $fault == method ]]; then printf 401; else printf 404; fi ;;
    *) if [[ $fault == namespace ]]; then printf 200; else printf 404; fi ;;
  esac
}
${helpers}
restore_nginx() { echo ROLLED_BACK_EXACT_VHOST; }
activated=true
${rollback}
trap on_error ERR
verify_technician_phone_gateway
echo TECHNICIAN_PHONE_GATEWAY_VERIFIED
`,
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}

test("technician phone probes are bounded and never submit an identity or SMS proof", () => {
  assert.match(helpers, /SECONDS \+ 45/);
  assert.match(helpers, /--connect-timeout 1 --max-time/);
  assert.match(helpers, /--data '\{\}'/);
  assert.doesNotMatch(helpers, /Authorization|Cookie|Bearer|--insecure|agreementsAccepted|challengeSecret/);
});

test("all nine exact routes are probed without sending SMS or creating a draft", { skip: !existsSync(bash) }, () => {
  const result = simulate("none");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TECHNICIAN_PHONE_GATEWAY_VERIFIED/);
  assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
  for (const path of ["status", "register", "profile", "photos", "documents", "submit"]) {
    assert.ok(result.stderr.includes(`/v1/technician/phone-onboarding/${path}\n`));
  }
});

for (const fault of ["schema", "missing", "anonymous", "method", "namespace", "transport"]) {
  test(`technician phone ${fault} regression rolls back the exact vhost`, { skip: !existsSync(bash) }, () => {
    const result = simulate(fault);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
    assert.doesNotMatch(result.stdout, /TECHNICIAN_PHONE_GATEWAY_VERIFIED/);
  });
}

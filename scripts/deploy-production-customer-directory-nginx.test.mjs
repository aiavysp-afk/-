import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(new URL("./deploy-production-nginx.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = deploy.indexOf("# Customer directory gateway probe helpers.");
const end = deploy.indexOf("# End customer directory gateway probe helpers.", start);
assert.ok(start >= 0 && end > start);
const helpers = deploy.slice(start, end);
const rollbackHandler = deploy.slice(deploy.indexOf("on_error() {"), deploy.indexOf("\ntrap on_error ERR"));
const bash = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "/bin/bash";
const canRunBash = existsSync(bash);

function simulate(fault) {
  const input = `set -euo pipefail
fault=${fault}
curl() {
  local method=GET url="\${@: -1}" previous= argument host= path=
  for argument in "$@"; do
    [[ $previous != --request ]] || method=$argument
    [[ $argument != --head ]] || method=HEAD
    case "$argument" in *Authorization*|*Cookie*|*Bearer*|--data|--insecure) return 90 ;; esac
    previous=$argument
  done
  host=\${url#https://}; host=\${host%%/*}
  [[ $host == api.mtsc.top || $host == admin.mtsc.top ]] || return 91
  path=\${url#https://$host}
  printf 'PROBE %s %s\n' "$method" "$url" >&2
  [[ $fault != transport ]] || return 7
  case "$method:$path" in
    GET:/v1/admin/organizations/probe/customer-center/customers|POST:/v1/admin/organizations/probe/customer-center/customers/probe/reveal-phone)
      if [[ $fault == missing ]]; then printf 404
      elif [[ $fault == unauthenticated ]]; then printf 200
      else printf 401; fi ;;
    GET:/v1/admin/organizations/probe/customer-center/customers/extra|GET:/v1/admin/organizations/probe/customer-center/customers/probe/reveal-phone/extra)
      if [[ $fault == namespace ]]; then printf 200; else printf 404; fi ;;
    *)
      if [[ $fault == method ]]; then printf 401
      elif [[ $fault == limit-deny ]]; then printf 403
      else printf 405; fi ;;
  esac
}
${helpers}
restore_nginx() { echo ROLLED_BACK_EXACT_VHOST; }
activated=true
${rollbackHandler}
trap on_error ERR
verify_customer_directory_gateway
echo CUSTOMER_DIRECTORY_VERIFIED
`;
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input, encoding: "utf8", timeout: 5_000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}

test("customer directory probes stay bounded, anonymous and TLS-verified", () => {
  assert.ok(helpers.includes("SECONDS + 30"));
  assert.ok(helpers.includes("customer_directory_deadline - SECONDS"));
  assert.ok(helpers.includes("--connect-timeout 1 --max-time"));
  assert.ok(helpers.includes("--noproxy '*'"));
  assert.ok(helpers.includes("for host in api.mtsc.top admin.mtsc.top"));
  assert.doesNotMatch(helpers, /Authorization|Cookie|Bearer|--data|--insecure|(?:^|\s)-k(?:\s|$)/);
  assert.ok(deploy.includes("verify_customer_directory_gateway\n"));
});

for (const fault of ["none", "limit-deny"]) test(
  `both private directory entry paths retain 401 and exact method boundaries (${fault})`,
  { skip: !canRunBash },
  () => {
    const result = simulate(fault);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOMER_DIRECTORY_VERIFIED/);
    assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
    for (const host of ["api.mtsc.top", "admin.mtsc.top"]) {
      assert.ok(result.stderr.includes(`PROBE GET https://${host}/v1/admin/organizations/probe/customer-center/customers\n`));
      assert.ok(result.stderr.includes(`PROBE POST https://${host}/v1/admin/organizations/probe/customer-center/customers/probe/reveal-phone\n`));
      assert.ok(result.stderr.includes(`PROBE HEAD https://${host}/v1/admin/organizations/probe/customer-center/customers\n`));
      assert.ok(result.stderr.includes(`PROBE HEAD https://${host}/v1/admin/organizations/probe/customer-center/customers/probe/reveal-phone\n`));
    }
  },
);

for (const [fault, error] of [
  ["missing", /Customer directory session gate failed/],
  ["unauthenticated", /Customer directory session gate failed/],
  ["method", /Customer phone method gate failed/],
  ["namespace", /Unexpected customer directory path is exposed/],
  ["transport", /Customer directory session gate failed/],
]) test(`customer directory ${fault} regression rolls back the exact vhost`, { skip: !canRunBash }, () => {
  const result = simulate(fault);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
  assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
  assert.doesNotMatch(result.stdout, /CUSTOMER_DIRECTORY_VERIFIED/);
});

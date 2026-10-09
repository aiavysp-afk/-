import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(new URL("./deploy-production-nginx.sh", import.meta.url), "utf8");
const begin = deploy.indexOf("# Private gateway probe helpers.");
const end = deploy.indexOf("# End private gateway probe helpers.", begin);
assert.ok(begin >= 0 && end > begin);
const helpers = deploy.slice(begin, end);
const rollbackHandler = deploy.slice(deploy.indexOf("on_error() {"), deploy.indexOf("\ntrap on_error ERR"));
const bash = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/bash";
const canRunBash = existsSync(bash);

function simulate(scenario) {
  const input = `set -euo pipefail
SECONDS=0
rounds=0
scenario=${scenario}
curl() {
  local url="\${@: -1}"
  case "$url" in
    https://api.mtsc.top/v1/health) printf 200 ;;
    https://admin.mtsc.top/) if [[ "$scenario" == stale ]] || (( rounds <= 2 )); then printf 503; else printf 200; fi ;;
    https://api.mtsc.top/v1/customer-center|https://admin.mtsc.top/v1/admin/catalog/services) printf 401 ;;
    https://admin.mtsc.top/v1/admin/unknown) printf 404 ;;
    *) echo 'Unexpected probe URL' >&2; return 90 ;;
  esac
}
# Simulate monotonic elapsed time without sleeping or creating files.
sleep() { SECONDS=$((SECONDS + 10)); }
${helpers}
original_verify="$(declare -f verify_private_gateway)"
eval "\${original_verify/verify_private_gateway/real_verify_private_gateway}"
verify_private_gateway() { rounds=$((rounds + 1)); real_verify_private_gateway; }
restore_nginx() { echo 'ROLLED_BACK_EXACT_VHOST'; return 0; }
activated=true
${rollbackHandler}
trap on_error ERR
wait_for_private_gateway
echo "READY_ROUNDS=$rounds API=$api_status ADMIN=$admin_status CUSTOMER=$customer_status CATALOG=$private_catalog_status UNKNOWN=$private_unknown_status"
`;
  return spawnSync(bash, ["--noprofile", "--norc"], { input, encoding: "utf8", timeout: 5_000, env: { ...process.env, BASH_ENV: "", ENV: "" } });
}

test("private reload convergence remains bounded and retains exact TLS and rollback gates", () => {
  assert.ok(helpers.includes("SECONDS + 30")); assert.ok(helpers.includes("attempts < 10"));
  assert.ok(helpers.includes("--connect-timeout 1 --max-time"));
  assert.ok(helpers.includes("private_gateway_deadline - SECONDS"));
  assert.ok(helpers.includes("Connection: close")); assert.ok(helpers.includes("--noproxy '*'"));
  assert.doesNotMatch(helpers, /--insecure|(?:^|\s)-k(?:\s|$)/);
  assert.ok(deploy.includes("public_admin_status == 503"));
  assert.ok(deploy.includes("restore_nginx")); assert.ok(deploy.includes("trap on_error ERR"));
});

test("two old-worker 503 rounds converge to all five required states on the third", { skip: !canRunBash }, () => {
  const result = simulate("recover");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /READY_ROUNDS=3 API=200 ADMIN=200 CUSTOMER=401 CATALOG=401 UNKNOWN=404/);
  assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
});

test("continued 503 exhausts the deadline and invokes the real rollback error handler", { skip: !canRunBash }, () => {
  const result = simulate("stale");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /did not converge: API=200 admin=503 customer=not-probed/);
  assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
  assert.doesNotMatch(result.stdout, /READY_ROUNDS/);
});

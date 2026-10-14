import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(
  new URL("./deploy-production-nginx.sh", import.meta.url),
  "utf8",
);
const begin = deploy.indexOf("# Private gateway probe helpers.");
const end = deploy.indexOf("# End private gateway probe helpers.", begin);
assert.ok(begin >= 0 && end > begin);
const helpers = deploy.slice(begin, end);
const customerBegin = deploy.indexOf("# Customer login gateway probe helpers.");
const customerEnd = deploy.indexOf(
  "# End customer login gateway probe helpers.",
  customerBegin,
);
assert.ok(customerBegin >= 0 && customerEnd > customerBegin);
const customerHelpers = deploy.slice(customerBegin, customerEnd);
const rollbackHandler = deploy.slice(
  deploy.indexOf("on_error() {"),
  deploy.indexOf("\ntrap on_error ERR"),
);
const bash =
  process.platform === "win32"
    ? join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      )
    : "/bin/bash";
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
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}

test("private reload convergence remains bounded and retains exact TLS and rollback gates", () => {
  assert.ok(helpers.includes("SECONDS + 30"));
  assert.ok(helpers.includes("attempts < 10"));
  assert.ok(helpers.includes("--connect-timeout 1 --max-time"));
  assert.ok(helpers.includes("private_gateway_deadline - SECONDS"));
  assert.ok(helpers.includes("Connection: close"));
  assert.ok(helpers.includes("--noproxy '*'"));
  assert.doesNotMatch(helpers, /--insecure|(?:^|\s)-k(?:\s|$)/);
  assert.ok(deploy.includes("public_admin_status == 503"));
  assert.ok(deploy.includes("restore_nginx"));
  assert.ok(deploy.includes("trap on_error ERR"));
});

test(
  "two old-worker 503 rounds converge to all five required states on the third",
  { skip: !canRunBash },
  () => {
    const result = simulate("recover");
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /READY_ROUNDS=3 API=200 ADMIN=200 CUSTOMER=401 CATALOG=401 UNKNOWN=404/,
    );
    assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
  },
);

test(
  "continued 503 exhausts the deadline and invokes the real rollback error handler",
  { skip: !canRunBash },
  () => {
    const result = simulate("stale");
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /did not converge: API=200 admin=503 customer=not-probed/,
    );
    assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
    assert.doesNotMatch(result.stdout, /READY_ROUNDS/);
  },
);

function simulateCustomer(scenario) {
  const input = `set -euo pipefail
scenario=${scenario}
curl() {
  local method=GET data= url="\${@: -1}" previous= argument
  for argument in "$@"; do
    [[ $previous != --request ]] || method=$argument
    [[ $previous != --data ]] || data=$argument
    [[ $argument != --head ]] || method=HEAD
    [[ $argument != *Authorization* ]] || return 90
    previous=$argument
  done
  if [[ $method == POST && $data != '{}' ]]; then echo 'Unsafe customer probe body' >&2; return 90; fi
  case "$url" in
    https://api.mtsc.top/v1/auth/customer-login/capabilities)
      if [[ $method == GET ]]; then
        if [[ $scenario == missing ]]; then printf 404; else printf 200; fi
      else printf 404; fi ;;
    https://api.mtsc.top/v1/auth/customer-login/wechat-phone|https://api.mtsc.top/v1/auth/customer-login/sms/request|https://api.mtsc.top/v1/auth/customer-login/sms/confirm)
      if [[ $method == POST ]]; then printf 400
      elif [[ $scenario == method-bypass && $method == GET ]]; then printf 401
      else printf 404; fi ;;
    https://api.mtsc.top/v1/auth/customer-login/|https://api.mtsc.top/v1/auth/customer-login/sms|https://api.mtsc.top/v1/auth/customer-login/wechat-phone/extra)
      if [[ $scenario == namespace-bypass ]]; then printf 200; else printf 404; fi ;;
    *) echo 'Unexpected customer probe URL' >&2; return 90 ;;
  esac
}
${customerHelpers}
restore_nginx() { echo 'ROLLED_BACK_EXACT_VHOST'; return 0; }
activated=true
${rollbackHandler}
trap on_error ERR
verify_customer_login_gateway
echo 'CUSTOMER_LOGIN_GATEWAY_VERIFIED'
`;
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}

test("customer login gateway probes use invalid empty JSON and bounded TLS requests only", () => {
  assert.ok(customerHelpers.includes("SECONDS + 30"));
  assert.ok(customerHelpers.includes("customer_login_deadline - SECONDS"));
  assert.ok(customerHelpers.includes("--connect-timeout 1 --max-time"));
  assert.ok(customerHelpers.includes("--data '{}'"));
  assert.ok(customerHelpers.includes("expected=(200 400 400 400)"));
  assert.ok(customerHelpers.includes("rejected=(POST GET GET GET)"));
  assert.ok(deploy.includes("verify_customer_login_gateway\n"));
  assert.doesNotMatch(
    customerHelpers,
    /--insecure|(?:^|\s)-k(?:\s|$)|Authorization|agreementsAccepted|--cookie/,
  );
});

test(
  "all four customer routes are probed without real authorization or SMS dispatch",
  { skip: !canRunBash },
  () => {
    const result = simulateCustomer("ok");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOMER_LOGIN_GATEWAY_VERIFIED/);
    assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
  },
);

for (const [scenario, error] of [
  ["missing", /Customer login route failed/],
  ["method-bypass", /Customer login method gate failed/],
  ["namespace-bypass", /Unexpected customer login path is exposed/],
]) {
  test(
    `customer gateway ${scenario} triggers the exact-vhost rollback`,
    { skip: !canRunBash },
    () => {
      const result = simulateCustomer(scenario);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
      assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
      assert.doesNotMatch(result.stdout, /CUSTOMER_LOGIN_GATEWAY_VERIFIED/);
    },
  );
}

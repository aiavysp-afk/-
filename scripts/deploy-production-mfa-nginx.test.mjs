import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(
  new URL("./deploy-production-nginx.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const begin = deploy.indexOf("# Session MFA gateway probe helpers.");
const end = deploy.indexOf("# End session MFA gateway probe helpers.", begin);
assert.ok(begin >= 0 && end > begin);
const helpers = deploy.slice(begin, end);
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

function simulate(fault = "none", publicSource = false) {
  const input = `set -euo pipefail
SECONDS=0
fault=${fault}
curl() {
  local method=GET address= source= url="\${@: -1}" previous= argument
  for argument in "$@"; do
    case "$previous" in
      --request) method=$argument ;;
      --resolve) address=$argument ;;
      --interface) source=$argument ;;
    esac
    [[ $argument != --head ]] || method=HEAD
    previous=$argument
  done
  [[ $address == api.mtsc.top:443:127.0.0.1 || $address == api.mtsc.top:443:203.0.113.10 ]] || return 90
  [[ -z $source || $source == 203.0.113.10 ]] || return 91
  printf 'PROBE %s %s SOURCE=%s\n' "$method" "$url" "\${source:-loopback}" >&2
  if [[ $fault == transport ]]; then return 7; fi
  case "$method:$url" in
    GET:https://api.mtsc.top/v1/auth/mfa|POST:https://api.mtsc.top/v1/auth/mfa/enrollment|POST:https://api.mtsc.top/v1/auth/mfa/activate|POST:https://api.mtsc.top/v1/auth/mfa/verify)
      case "$fault" in
        unauthenticated) printf 200 ;;
        still-private) printf 403 ;;
        *) printf 401 ;;
      esac ;;
    GET:https://api.mtsc.top/v1/auth/mfa/|GET:https://api.mtsc.top/v1/auth/mfa/recovery|GET:https://api.mtsc.top/v1/auth/mfa/verify/extra)
      if [[ $fault == unknown-path ]]; then printf 401; elif [[ -n $source ]]; then printf 403; else printf 404; fi ;;
    GET:https://api.mtsc.top/v1/admin/catalog/services)
      if [[ $fault == public-admin ]]; then printf 401; else printf 403; fi ;;
    *)
      if [[ $fault == unsupported-method ]]; then printf 401; else printf 404; fi ;;
  esac
}
${helpers}
restore_nginx() { echo ROLLED_BACK_EXACT_VHOST; }
activated=true
${rollbackHandler}
trap on_error ERR
verify_mfa_gateway ${publicSource ? "203.0.113.10 203.0.113.10" : "127.0.0.1"}
echo MFA_GATES_VERIFIED
`;
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}

test("MFA release probes are bounded, anonymous, TLS-verified and never mutate identity", () => {
  assert.ok(helpers.includes("SECONDS + 30"));
  assert.ok(helpers.includes("--connect-timeout 1 --max-time"));
  assert.ok(helpers.includes("--noproxy '*'"));
  assert.ok(helpers.includes("Connection: close"));
  assert.ok(helpers.includes("[[ $status == 401 ]]"));
  assert.ok(helpers.includes("[[ $status == 404 ]]"));
  assert.ok(helpers.includes("[[ $status == 403 ]]"));
  assert.doesNotMatch(
    helpers,
    /--data|--insecure|(?:^|\s)-k(?:\s|$)|--header ['"](?:Origin|Authorization|Cookie):/,
  );
  assert.ok(deploy.includes("verify_mfa_gateway 127.0.0.1"));
  assert.ok(
    deploy.includes('verify_mfa_gateway "$public_ipv4" "$public_ipv4"'),
  );
  assert.ok(
    deploy.includes(
      "Private/NAT source detected: independent external verification",
    ),
  );
  for (const path of [
    "/v1/auth/mfa",
    "/v1/auth/mfa/enrollment",
    "/v1/auth/mfa/activate",
    "/v1/auth/mfa/verify",
  ]) {
    assert.ok(deploy.includes(`'location = ${path} {'`));
    assert.ok(deploy.includes(`'"0:${path}" 0;'`));
  }
});

for (const publicSource of [false, true]) {
  test(
    `MFA probes accept only authenticated boundaries from ${publicSource ? "public" : "loopback"} sources`,
    { skip: !canRunBash },
    () => {
      const result = simulate("none", publicSource);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /MFA_GATES_VERIFIED/);
      assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
      for (const route of [
        "mfa",
        "mfa/enrollment",
        "mfa/activate",
        "mfa/verify",
      ]) {
        assert.match(
          result.stderr,
          new RegExp(
            `PROBE HEAD https://api\\.mtsc\\.top/v1/auth/${route} SOURCE=`,
          ),
        );
        assert.match(
          result.stderr,
          new RegExp(
            `PROBE PATCH https://api\\.mtsc\\.top/v1/auth/${route} SOURCE=`,
          ),
        );
      }
      assert.equal(
        result.stderr.includes("/v1/admin/catalog/services"),
        publicSource,
      );
    },
  );
}

for (const fault of [
  "unauthenticated",
  "still-private",
  "unsupported-method",
  "unknown-path",
  "transport",
  "public-admin",
]) {
  test(
    `MFA regression ${fault} invokes the existing exact-vhost rollback`,
    { skip: !canRunBash },
    () => {
      const result = simulate(fault, true);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /ROLLED_BACK_EXACT_VHOST/);
      assert.doesNotMatch(result.stdout, /MFA_GATES_VERIFIED/);
    },
  );
}

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const deploy = readFileSync(
  new URL("./deploy-production-technician-nginx.sh", import.meta.url),
  "utf8",
);
// Deployed Git archives use LF; Windows checkouts may contain mixed newlines.
const template = readFileSync(
  new URL("../infra/maintenance/mtsc.top.conf", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
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
const oldPolicy =
  "default-src 'self'; connect-src https://api.mtsc.top; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const newPolicy = oldPolicy.replace("data: https:", "data: blob: https:");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function section(begin, end) {
  const start = deploy.indexOf(begin);
  const finish = deploy.indexOf(end, start);
  assert.ok(start >= 0 && finish > start);
  return deploy.slice(start, finish);
}
const candidateHelper = section(
  "# Technician candidate helper:",
  "# End technician candidate helper.",
);
const probeHelpers = section(
  "# Technician reload probe helpers:",
  "# End technician reload probe helpers.",
);
const restoreHelper = section(
  "restore_technician_nginx() {",
  "\n# Technician reload probe helpers:",
);
const errorHandler = section("on_error() {", "\ntrap on_error ERR");
function execute(input) {
  return spawnSync(bash, ["--noprofile", "--norc"], {
    input,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
}
function transform(source) {
  const directory = mkdtempSync(join(tmpdir(), "zydj-technician-nginx-test-"));
  try {
    const target = join(directory, "target.conf");
    const candidate = join(directory, "candidate.conf");
    writeFileSync(target, source);
    const result = execute(`set -euo pipefail
target=${shellQuote(target.replaceAll("\\", "/"))}
candidate=${shellQuote(candidate.replaceAll("\\", "/"))}
old_policy=${shellQuote(oldPolicy)}
new_policy=${shellQuote(newPolicy)}
${candidateHelper}
build_technician_candidate
`);
    return {
      ...result,
      candidate: existsSync(candidate) ? readFileSync(candidate, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function probe(scenario, rollbackFails = false) {
  return execute(`set -euo pipefail
SECONDS=0
rounds=0
new_policy=${shellQuote(newPolicy)}
scenario=${scenario}
curl() {
  local url="\${@: -1}"
  case "$url" in
    https://mtsc.top/technician/) if [[ "$scenario" == stale ]] || (( rounds <= 2 )); then
      printf '%s\\r\\n' 'HTTP/1.1 200 OK' ${shellQuote(`Content-Security-Policy: ${oldPolicy}`)};
      else printf '%s\\r\\n' 'HTTP/1.1 200 OK' ${shellQuote(`Content-Security-Policy: ${newPolicy}`)}; fi ;;
    https://mtsc.top/) printf 503 ;;
    https://admin.mtsc.top/) printf 200 ;;
    *) return 90 ;;
  esac
}
sleep() { SECONDS=$((SECONDS + 10)); }
${probeHelpers}
original_verify="$(declare -f verify_technician_gateway)"
eval "\${original_verify/verify_technician_gateway/real_verify_technician_gateway}"
verify_technician_gateway() { rounds=$((rounds + 1)); real_verify_technician_gateway; }
restore_technician_nginx() { echo ROLLED_BACK_EXACT_ROOT_VHOST; return ${rollbackFails ? 1 : 0}; }
activated=true
${errorHandler}
trap on_error ERR
wait_for_technician_gateway
echo "READY_ROUNDS=$rounds"
`);
}

test("technician config publication binds a loaded root vhost, shared lock and exact deployed H5", () => {
  for (const marker of [
    'exec 8>"$base/nginx-deploy.lock"',
    "flock -n 8",
    "current_nginx_dump=$(nginx -T 2>&1)",
    '$(readlink -f -- "$loaded_vhost") == "$target"',
    "[[ $target == /etc/nginx/* && -f $target ]]",
    '$(readlink -f "$web_base/current") == "$web_base/releases/$release_id"',
    'cp -a -- "$target" "$backup"',
    'cmp -s -- "$backup" "$target"',
    "validate_nginx",
    "systemctl reload nginx.service",
    "restore_technician_nginx",
    "exit 70",
    "if ($zydj_admin_network_allowed = 0) { return 503 maintenance; }",
  ])
    assert.ok(deploy.includes(marker), `missing boundary: ${marker}`);
  assert.doesNotMatch(
    deploy,
    /retire-legacy-mall\.sh|api\.env|pg_dump|prisma migrate|systemctl (?:restart|stop) zhongyuan|rm -rf|--insecure/,
  );
  assert.ok(probeHelpers.includes("SECONDS + 30"));
  assert.ok(probeHelpers.includes("attempts < 10"));
  assert.ok(probeHelpers.includes("[[ $main_status == 503 ]]"));
  assert.ok(probeHelpers.includes("[[ $admin_status == 200 ]]"));
});

test(
  "candidate changes only the two image sources and retains exact root maintenance policy",
  { skip: !canRunBash },
  () => {
    const original = template.replaceAll(newPolicy, oldPolicy);
    const result = transform(original);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.candidate, template);
  },
);

test(
  "already upgraded policies remain idempotent",
  { skip: !canRunBash },
  () => {
    const result = transform(template);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.candidate, template);
  },
);

test(
  "unexpected CSP and missing/extra policies fail before activation",
  { skip: !canRunBash },
  () => {
    const original = template.replaceAll(newPolicy, oldPolicy);
    for (const source of [
      original.replace(
        oldPolicy,
        oldPolicy.replace("script-src 'self'", "script-src *"),
      ),
      original.replace(oldPolicy, "default-src 'none'"),
      original + `add_header Content-Security-Policy "${oldPolicy}" always;\n`,
    ]) {
      const result = transform(source);
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /Expected exactly two unchanged technician CSP directives/,
      );
    }
  },
);

test(
  "new worker image policy converges after two old-worker responses",
  { skip: !canRunBash },
  () => {
    const result = probe("recover");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /READY_ROUNDS=3/);
    assert.doesNotMatch(result.stdout, /ROLLED_BACK/);
  },
);

test(
  "rollback restores exact saved bytes and retains its backup",
  { skip: !canRunBash },
  () => {
    const directory = mkdtempSync(
      join(tmpdir(), "zydj-technician-nginx-test-"),
    );
    try {
      const target = join(directory, "target.conf");
      const candidate = join(directory, "candidate.conf");
      const backup = join(directory, "before.conf");
      const original = template.replaceAll(newPolicy, oldPolicy);
      writeFileSync(target, template);
      writeFileSync(backup, original);
      const result = execute(`set -euo pipefail
target=${shellQuote(target.replaceAll("\\", "/"))}
candidate=${shellQuote(candidate.replaceAll("\\", "/"))}
backup=${shellQuote(backup.replaceAll("\\", "/"))}
validate_nginx() { return 0; }
systemctl() { [[ "$*" == 'reload nginx.service' || "$*" == 'is-active --quiet nginx.service' ]]; }
${restoreHelper}
restore_technician_nginx
`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(readFileSync(backup, "utf8"), original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "rollback never activates a partial backup or reloads an invalid restored configuration",
  { skip: !canRunBash },
  () => {
    for (const failure of ["copy", "validate"]) {
      const directory = mkdtempSync(
        join(tmpdir(), "zydj-technician-nginx-test-"),
      );
      try {
        const target = join(directory, "target.conf");
        const candidate = join(directory, "candidate.conf");
        const backup = join(directory, "before.conf");
        const original = template.replaceAll(newPolicy, oldPolicy);
        writeFileSync(target, template);
        writeFileSync(backup, original);
        const result = execute(`set -euo pipefail
target=${shellQuote(target.replaceAll("\\", "/"))}
candidate=${shellQuote(candidate.replaceAll("\\", "/"))}
backup=${shellQuote(backup.replaceAll("\\", "/"))}
${failure === "copy" ? 'cp() { printf partial > "$candidate"; return 1; }' : ""}
validate_nginx() { return ${failure === "validate" ? 1 : 0}; }
systemctl() { echo UNEXPECTED_RELOAD; return 0; }
${restoreHelper}
restore_technician_nginx
`);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(
          readFileSync(target, "utf8"),
          failure === "copy" ? template : original,
        );
        assert.equal(readFileSync(backup, "utf8"), original);
        assert.doesNotMatch(result.stdout, /UNEXPECTED_RELOAD/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "continued old CSP reaches its deadline and restores the exact vhost",
  { skip: !canRunBash },
  () => {
    const result = probe("stale");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /did not converge/);
    assert.match(result.stdout, /ROLLED_BACK_EXACT_ROOT_VHOST/);
  },
);

test(
  "failed rollback is distinguished from a recovered deployment",
  { skip: !canRunBash },
  () => {
    const result = probe("stale", true);
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /rollback is incomplete/);
  },
);

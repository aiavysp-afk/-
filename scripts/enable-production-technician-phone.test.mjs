import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertTechnicianPhoneCapabilities,
  assertTechnicianPhoneMetadata,
  enableTechnicianPhone,
  inspectTechnicianPhoneEnvironment,
  prepareTechnicianPhoneEnable,
  runCli,
  TECHNICIAN_PHONE_METADATA_QUERY,
} from "./enable-production-technician-phone.mjs";

const release = "a".repeat(40);
const original = Buffer.from(
  [
    "# Synthetic non-production fixture only.",
    "NODE_ENV=production",
    "AUTH_PROVIDER=wechat",
    "SMS_PROVIDER=aliyun",
    "STAFF_BROWSER_LOGIN_ENABLED=true",
    "STAFF_MFA_REQUIRED=true",
    "STAFF_TRUSTED_DEVICE_ENABLED=true",
    "STAFF_PASSWORD_LOGIN_ENABLED=true",
    "STAFF_PASSWORD_SETUP_ENABLED=true",
    "SMS_SEND_ENABLED=true",
    "PHONE_VERIFICATION_SMS_ENABLED=true",
    "CUSTOMER_SMS_LOGIN_ENABLED=true",
    "PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT=20",
    "ALIYUN_SMS_ACCESS_KEY_ID=LTAIunitonlyfixture000000",
    "ALIYUN_SMS_ACCESS_KEY_SECRET=notarealsecretunitfixture000000",
    "ALIYUN_SMS_SIGN_NAME='测试签名'",
    "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE=SMS_UNITONLY",
    "ALIYUN_SMS_SECURITY_TOKEN=''",
    " export TECHNICIAN_PHONE_LOGIN_ENABLED = 'false' # preserve login comment",
    'TECHNICIAN_PHONE_WORKBENCH_ENABLED="false" # preserve workbench comment',
    "WECHAT_PAY_PREPAY_ENABLED=true",
    "WECHAT_PAY_REFUND_ENABLED=false",
    "SAFETY_NOTIFICATION_DISPATCH_ENABLED=false",
    "SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED=false",
    "DATABASE_URL='postgresql://unchanged-unit-only' # unchanged",
    "OTHER_CONFIG = '中文 and spaces'",
    "",
  ].join("\r\n"),
);

function fixture(mode = "login", bytes = original) {
  const envPath = "/fixture/api.env";
  let inode = 10;
  const safeStat = (size) => ({
    ino: inode++,
    dev: 1,
    gid: 17,
    uid: 0,
    mode: 0o100600,
    nlink: 1,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const files = new Map([
    [envPath, { bytes: Buffer.from(bytes), stat: safeStat(bytes.length) }],
  ]);
  const state = {
    writes: [],
    renames: [],
    unlinks: [],
    contexts: [],
    validations: 0,
    readiness: 0,
    restarts: 0,
    probes: [],
    pauses: 0,
    held: true,
    running: true,
    released: false,
  };
  const rt = {
    envPath,
    attempts: 2,
    async acquireLock() {
      return {
        assertHeld() {
          assert.equal(state.held, true);
        },
        async release() {
          state.released = true;
        },
      };
    },
    checkContext(requireRunning = true) {
      state.contexts.push(requireRunning);
      if (requireRunning) assert.equal(state.running, true);
    },
    readSecure(path) {
      const row = files.get(path);
      assert.ok(row);
      return { bytes: Buffer.from(row.bytes), stat: { ...row.stat } };
    },
    writeSecure(path, data, gid) {
      assert.equal(files.has(path), false);
      assert.equal(gid, 17);
      state.writes.push(path);
      const stat = safeStat(data.length);
      files.set(path, { bytes: Buffer.from(data), stat });
      return { ...stat };
    },
    rename(from, to) {
      assert.ok(files.has(from));
      state.renames.push([from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink(path) {
      state.unlinks.push(path);
      files.delete(path);
    },
    syncDirectory() {},
    async validate(raw) {
      state.validations++;
      for (const key of [
        "STAFF_BROWSER_LOGIN_ENABLED",
        "STAFF_MFA_REQUIRED",
        "STAFF_PASSWORD_LOGIN_ENABLED",
        "STAFF_PASSWORD_SETUP_ENABLED",
        "STAFF_TRUSTED_DEVICE_ENABLED",
        "CUSTOMER_SMS_LOGIN_ENABLED",
      ])
        assert.equal(raw[key], "true");
      assert.equal(raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT, "20");
      assert.equal(raw.WECHAT_PAY_REFUND_ENABLED, "false");
      assert.equal(raw.WECHAT_PAY_PREPAY_ENABLED, "true");
    },
    async assertAliasReady() {
      state.readiness++;
    },
    restart() {
      state.restarts++;
      state.running = true;
    },
    async probe(enabled) {
      state.probes.push(enabled);
      assert.equal(state.running, true);
      const raw = inspectTechnicianPhoneEnvironment(
        files.get(envPath).bytes,
      ).raw;
      assert.equal(
        raw[
          mode === "login"
            ? "TECHNICIAN_PHONE_LOGIN_ENABLED"
            : "TECHNICIAN_PHONE_WORKBENCH_ENABLED"
        ] === "true",
        enabled,
      );
      if (mode === "login")
        assert.equal(raw.TECHNICIAN_PHONE_WORKBENCH_ENABLED, "false");
      else assert.equal(raw.TECHNICIAN_PHONE_LOGIN_ENABLED, "true");
    },
    async pause() {
      state.pauses++;
    },
  };
  return { rt, state, files, envPath, safeStat };
}
const active = (f) => f.files.get(f.envPath).bytes;
const pending = (f) =>
  [...f.files.keys()].filter((path) => path.endsWith(".pending"));

test("login activation changes only its exact gate, preserving all other bytes, comments, CRLF and daily 20 budget", () => {
  const candidate = prepareTechnicianPhoneEnable(original, "login");
  assert.equal(candidate.alreadyEnabled, false);
  assert.deepEqual(
    candidate.bytes,
    Buffer.from(
      original
        .toString()
        .replace(
          "TECHNICIAN_PHONE_LOGIN_ENABLED = 'false'",
          "TECHNICIAN_PHONE_LOGIN_ENABLED = true",
        ),
    ),
  );
  const before = inspectTechnicianPhoneEnvironment(original).raw;
  assert.deepEqual(
    {
      ...candidate.raw,
      TECHNICIAN_PHONE_LOGIN_ENABLED: before.TECHNICIAN_PHONE_LOGIN_ENABLED,
    },
    before,
  );
  assert.equal(candidate.raw.TECHNICIAN_PHONE_WORKBENCH_ENABLED, "false");
});

test("workbench activation requires already-enabled dedicated technician login and only opens its own gate", () => {
  assert.throws(() => prepareTechnicianPhoneEnable(original, "workbench"));
  const login = prepareTechnicianPhoneEnable(original, "login").bytes;
  const candidate = prepareTechnicianPhoneEnable(login, "workbench");
  assert.deepEqual(
    candidate.bytes,
    Buffer.from(
      login
        .toString()
        .replace(
          'TECHNICIAN_PHONE_WORKBENCH_ENABLED="false"',
          "TECHNICIAN_PHONE_WORKBENCH_ENABLED=true",
        ),
    ),
  );
  assert.equal(candidate.raw.TECHNICIAN_PHONE_LOGIN_ENABLED, "true");
});

test("absent gate appends one line without rewriting other bytes or opening workbench", () => {
  const bytes = Buffer.from(
    original
      .toString()
      .replace(/ export TECHNICIAN_PHONE_LOGIN_ENABLED[^\n]*\n/, "")
      .replace(/\r\n$/, ""),
  );
  const candidate = prepareTechnicianPhoneEnable(bytes, "login");
  assert.deepEqual(
    candidate.bytes,
    Buffer.concat([
      bytes,
      Buffer.from("\r\nTECHNICIAN_PHONE_LOGIN_ENABLED=true\r\n"),
    ]),
  );
});

test("already enabled is byte-identical; arbitrary modes, malformed gates and workbench-without-login are refused", () => {
  const enabled = prepareTechnicianPhoneEnable(original, "login").bytes;
  const result = prepareTechnicianPhoneEnable(enabled, "login");
  assert.equal(result.alreadyEnabled, true);
  assert.deepEqual(result.bytes, enabled);
  for (const mode of [
    undefined,
    "",
    "all",
    "STAFF_MFA_REQUIRED",
    "TECHNICIAN_PHONE_LOGIN_ENABLED",
    "../../unsafe",
    true,
  ])
    assert.throws(() => prepareTechnicianPhoneEnable(original, mode));
  for (const value of ["1", "yes", "TRUE", "", "undefined"])
    for (const gate of [
      "TECHNICIAN_PHONE_LOGIN_ENABLED",
      "TECHNICIAN_PHONE_WORKBENCH_ENABLED",
    ])
      assert.throws(() =>
        prepareTechnicianPhoneEnable(
          Buffer.from(
            original
              .toString()
              .replace(new RegExp(`${gate}[^\\r\\n]*`), `${gate}=${value}`),
          ),
          "login",
        ),
      );
  assert.throws(() =>
    prepareTechnicianPhoneEnable(
      Buffer.from(
        original
          .toString()
          .replace('WORKBENCH_ENABLED="false"', 'WORKBENCH_ENABLED="true"'),
      ),
      "login",
    ),
  );
});

for (const key of [
  "STAFF_BROWSER_LOGIN_ENABLED",
  "STAFF_MFA_REQUIRED",
  "STAFF_PASSWORD_LOGIN_ENABLED",
  "STAFF_TRUSTED_DEVICE_ENABLED",
  "SMS_SEND_ENABLED",
  "PHONE_VERIFICATION_SMS_ENABLED",
  "CUSTOMER_SMS_LOGIN_ENABLED",
])
  test(`required gate ${key} cannot be bypassed or implicitly enabled`, () => {
    for (const value of ["false", ""])
      assert.throws(() =>
        prepareTechnicianPhoneEnable(
          Buffer.from(
            original
              .toString()
              .replace(
                `${key}=true`,
                value ? `${key}=${value}` : `# missing ${key}`,
              ),
          ),
          "login",
        ),
      );
  });

test("strictly preserves the agreed shared daily 20 request budget and refuses provider or parsing drift", () => {
  for (const value of ["", "0", "1", "21", "10000", "020", "20.0", "-1"])
    assert.throws(() =>
      prepareTechnicianPhoneEnable(
        Buffer.from(
          original
            .toString()
            .replace("DAILY_REQUEST_LIMIT=20", `DAILY_REQUEST_LIMIT=${value}`),
        ),
        "login",
      ),
    );
  for (const [before, after] of [
    ["NODE_ENV=production", "NODE_ENV=test"],
    ["AUTH_PROVIDER=wechat", "AUTH_PROVIDER=mock"],
    ["SMS_PROVIDER=aliyun", "SMS_PROVIDER=none"],
    ["LTAIunitonlyfixture000000", "invalid"],
    ["SMS_UNITONLY", "invalid"],
    ["ALIYUN_SMS_SECURITY_TOKEN=''", "ALIYUN_SMS_SECURITY_TOKEN=sts"],
  ])
    assert.throws(() =>
      prepareTechnicianPhoneEnable(
        Buffer.from(original.toString().replace(before, after)),
        "login",
      ),
    );
  for (const extra of [
    "TECHNICIAN_PHONE_LOGIN_ENABLED=false\n",
    "OTHER_CONFIG=second\n",
    "not assignment\n",
    "\0",
  ])
    assert.throws(() =>
      prepareTechnicianPhoneEnable(
        Buffer.concat([original, Buffer.from(extra)]),
        "login",
      ),
    );
  assert.throws(() =>
    prepareTechnicianPhoneEnable(
      Buffer.concat([original, Buffer.from([0xff])]),
      "login",
    ),
  );
  assert.throws(() =>
    prepareTechnicianPhoneEnable(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
      "login",
    ),
  );
});

test("metadata requires all 13 challenge columns, indexes, attempts and Session scope constraints and finished migrations", () => {
  const keys = [
    "tableReady",
    "columnsReady",
    "primaryKeyReady",
    "noForeignKeysReady",
    "attemptsCheckReady",
    "indexesReady",
    "sessionScopeReady",
    "sessionProvenanceReady",
    "migrationReady",
    "noPendingMigrationsReady",
  ];
  const row = Object.fromEntries(keys.map((key) => [key, true]));
  assert.doesNotThrow(() => assertTechnicianPhoneMetadata([row]));
  for (const key of keys)
    for (const value of [false, undefined, 1])
      assert.throws(() =>
        assertTechnicianPhoneMetadata([{ ...row, [key]: value }]),
      );
  for (const rows of [null, [], [row, row]])
    assert.throws(() => assertTechnicianPhoneMetadata(rows));
  assert.match(TECHNICIAN_PHONE_METADATA_QUERY, /count\(\*\)=13/);
  assert.match(
    TECHNICIAN_PHONE_METADATA_QUERY,
    /20261022010000_technician_phone_login/,
  );
  assert.match(
    TECHNICIAN_PHONE_METADATA_QUERY,
    /Session_technician_phone_scope_check/,
  );
  assert.match(
    TECHNICIAN_PHONE_METADATA_QUERY,
    /Session_auth_provenance_check/,
  );
  assert.ok(
    TECHNICIAN_PHONE_METADATA_QUERY.includes("customerPhoneHash%IS NULL%"),
  );
  assert.ok(
    TECHNICIAN_PHONE_METADATA_QUERY.includes(
      "customerPhoneHash%~%''^[0-9a-f]{64}$''%",
    ),
  );
  for (const pair of [
    "authChannel%LEGACY%authProvider%unknown%",
    "authChannel%WECHAT_MINIAPP%ADMIN_BROWSER%authProvider%wechat%mock%",
    "authChannel%ADMIN_BROWSER%authProvider%staff-password%",
    "authChannel%CUSTOMER_SMS%authProvider%customer-sms%",
    "authChannel%TECHNICIAN_PHONE%authProvider%technician-sms%",
  ])
    assert.ok(TECHNICIAN_PHONE_METADATA_QUERY.includes(pair), pair);
  for (const key of [
    "wechatIdentityId",
    "staffVerifiedUntil",
    "staffVerificationMethod",
    "staffPasswordVersion",
    "trustedDeviceId",
    "mfaVerifiedUntil",
  ])
    assert.ok(TECHNICIAN_PHONE_METADATA_QUERY.includes(`${key}%IS NULL%`));
  assert.doesNotMatch(
    TECHNICIAN_PHONE_METADATA_QUERY,
    /SELECT \*|FROM public\."(?:User|Session|TechnicianPhoneLoginChallenge)"|INSERT|UPDATE|DELETE|ALTER/,
  );
});

test("capabilities need literal exact booleans and cannot imply workbench authority from login alone", () => {
  const expected = { enabled: true, workbenchEnabled: false };
  assert.doesNotThrow(() =>
    assertTechnicianPhoneCapabilities({ data: expected }, expected),
  );
  for (const value of [
    null,
    {},
    [],
    { data: { enabled: "true", workbenchEnabled: false } },
    { data: { enabled: true, workbenchEnabled: true } },
    { data: { enabled: true } },
  ])
    assert.throws(() => assertTechnicianPhoneCapabilities(value, expected));
});

test("a new isolated scope check cannot hide an unchanged old provenance check that rejects phone sessions", async () => {
  const f = fixture();
  f.rt.assertAliasReady = async () => {
    assertTechnicianPhoneMetadata([
      {
        tableReady: true,
        columnsReady: true,
        primaryKeyReady: true,
        noForeignKeysReady: true,
        attemptsCheckReady: true,
        indexesReady: true,
        sessionScopeReady: true,
        sessionProvenanceReady: false,
        migrationReady: true,
        noPendingMigrationsReady: true,
      },
    ]);
  };
  await assert.rejects(
    enableTechnicianPhone({ release, mode: "login" }, f.rt),
    /refused/,
  );
  assert.deepEqual(active(f), original);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.state.restarts, 0);
});

for (const mode of ["login", "workbench"])
  test(`${mode} activation uses locked atomic backup and unchanged other authority, then idempotent readiness without writes`, async () => {
    const bytes =
      mode === "login"
        ? original
        : prepareTechnicianPhoneEnable(original, "login").bytes;
    const f = fixture(mode, bytes),
      before = active(f);
    const result = await enableTechnicianPhone({ release, mode }, f.rt);
    assert.equal(result.status, "ENABLED");
    assert.deepEqual(
      active(f),
      prepareTechnicianPhoneEnable(before, mode).bytes,
    );
    assert.deepEqual(f.files.get(result.backup).bytes, before);
    assert.equal(f.files.get(result.backup).stat.mode, 0o100600);
    assert.equal(f.files.get(result.backup).stat.uid, 0);
    assert.equal(f.files.get(result.backup).stat.gid, 17);
    assert.deepEqual(f.state.probes, [false, true]);
    assert.equal(f.state.validations, 2);
    assert.equal(f.state.readiness, 1);
    assert.equal(f.state.restarts, 1);
    assert.equal(f.state.released, true);
    const count = f.state.writes.length;
    assert.equal(
      (await enableTechnicianPhone({ release, mode }, f.rt)).status,
      "ALREADY_ENABLED",
    );
    assert.equal(f.state.writes.length, count);
    assert.equal(f.state.restarts, 1);
  });

test("invalid release/mode is refused before lock or file access, including path and arbitrary-key attempts", async () => {
  const f = fixture();
  f.rt.acquireLock = () => {
    assert.fail("must not lock");
  };
  for (const value of [
    "",
    "main",
    "A".repeat(40),
    "a".repeat(39),
    `${release}\n`,
  ])
    await assert.rejects(
      enableTechnicianPhone({ release: value, mode: "login" }, f.rt),
      /refused/,
    );
  for (const mode of [undefined, "all", "STAFF_MFA_REQUIRED", "../../unsafe"])
    await assert.rejects(
      enableTechnicianPhone({ release, mode }, f.rt),
      /refused/,
    );
  assert.deepEqual(f.state.writes, []);
});

test("a delegated candidate cannot change other gates, budget or paths", async () => {
  const f = fixture();
  f.rt.prepareCandidate = () => ({
    bytes: Buffer.from("STAFF_MFA_REQUIRED=false\n"),
  });
  await assert.rejects(
    enableTechnicianPhone({ release, mode: "login" }, f.rt),
    /refused/,
  );
  assert.deepEqual(active(f), original);
  assert.deepEqual(f.state.writes, []);
});

for (const phase of [
  "acquireLock",
  "checkContext",
  "validate",
  "assertAliasReady",
  "probe",
])
  test(`${phase} failure is sanitized and makes no configuration writes`, async () => {
    const f = fixture();
    f.rt[phase] = () => {
      throw Error("private-error-must-not-escape");
    };
    await assert.rejects(
      enableTechnicianPhone({ release, mode: "login" }, f.rt),
      (error) => {
        assert.equal(
          error.message,
          "Technician phone activation refused; active configuration unchanged",
        );
        return true;
      },
    );
    assert.deepEqual(active(f), original);
    assert.deepEqual(f.state.writes, []);
  });

test("failed post-restart probes are bounded, restore exact bytes and verify original closed feature", async () => {
  const f = fixture(),
    probe = f.rt.probe;
  f.rt.probe = async (value) => {
    await probe(value);
    if (value) throw Error("mismatch");
  };
  await assert.rejects(
    enableTechnicianPhone({ release, mode: "login" }, f.rt),
    /original configuration restored and verified/,
  );
  assert.deepEqual(active(f), original);
  assert.deepEqual(f.state.probes, [false, true, true, false]);
  assert.equal(f.state.pauses, 1);
  assert.equal(f.state.restarts, 2);
  assert.deepEqual(pending(f), []);
  assert.equal(f.state.released, true);
});

test("a failed restart may have PID zero and still rolls back under original context safely", async () => {
  const f = fixture();
  f.rt.restart = () => {
    f.state.restarts++;
    f.state.running = f.state.restarts !== 1;
    if (!f.state.running) throw Error("restart failed");
  };
  await assert.rejects(
    enableTechnicianPhone({ release, mode: "login" }, f.rt),
    /restored and verified/,
  );
  assert.deepEqual(active(f), original);
  assert.equal(f.state.restarts, 2);
  assert.equal(f.state.contexts.filter((value) => value === false).length, 2);
});

test("outside byte/inode drift before replacement is preserved and only owned pending files are cleaned", async () => {
  for (const kind of ["bytes", "inode"]) {
    const f = fixture(),
      context = f.rt.checkContext;
    const outside = Buffer.concat([original, Buffer.from("OUTSIDE=true\n")]);
    f.rt.checkContext = (...args) => {
      context(...args);
      if (f.state.contexts.length === 2) {
        if (kind === "bytes") f.files.get(f.envPath).bytes = outside;
        else f.files.get(f.envPath).stat.ino++;
      }
    };
    await assert.rejects(
      enableTechnicianPhone({ release, mode: "login" }, f.rt),
      /refused/,
    );
    assert.deepEqual(active(f), kind === "bytes" ? outside : original);
    assert.equal(f.state.restarts, 0);
    assert.deepEqual(pending(f), []);
  }
});

test("outside drift or lost lock after replacement is critical and never overwritten by rollback", async () => {
  for (const kind of ["bytes", "inode", "lock"]) {
    const f = fixture();
    f.rt.restart = () => {
      f.state.restarts++;
      if (kind === "bytes")
        f.files.get(f.envPath).bytes = Buffer.from("OUTSIDE=true\n");
      else if (kind === "inode") f.files.get(f.envPath).stat.ino++;
      else f.state.held = false;
      throw Error("outside drift");
    };
    await assert.rejects(
      enableTechnicianPhone({ release, mode: "login" }, f.rt),
      /CRITICAL: technician phone activation rollback requires attention/,
    );
    assert.equal(f.state.renames.length, 1);
    assert.equal(f.state.restarts, 1);
    if (kind === "bytes") assert.equal(active(f).toString(), "OUTSIDE=true\n");
  }
});

test("tampered or colliding pending candidates are retained rather than deleting outside files", async () => {
  for (const kind of ["tampered", "collision"]) {
    const f = fixture(),
      write = f.rt.writeSecure;
    f.rt.writeSecure = (path, bytes, gid) => {
      const stat = write(path, bytes, gid);
      if (path.endsWith(".pending")) {
        if (kind === "tampered")
          f.files.get(path).bytes = Buffer.from("OUTSIDE=true\n");
        else throw Error("simulated exclusive collision");
      }
      return stat;
    };
    await assert.rejects(
      enableTechnicianPhone({ release, mode: "login" }, f.rt),
      /refused/,
    );
    assert.equal(f.state.unlinks.length, 0);
    assert.equal(pending(f).length, 1);
    assert.deepEqual(active(f), original);
  }
});

test("CLI accepts no extra key, path, secret or combined flag option and never echoes arguments", async () => {
  for (const args of [
    [],
    ["--confirm-enable-technician-phone-login", "main"],
    [
      "--confirm-enable-technician-phone-login",
      release,
      "--env-file",
      "/unsafe",
    ],
    ["--confirm-enable-technician-phone-workbench", release, "--also-login"],
    ["--confirm-enable-technician-phone-login", release, "secret"],
  ]) {
    const messages = [];
    assert.equal(
      await runCli(args, {
        log: (value) => messages.push(value),
        error: (value) => messages.push(value),
      }),
      1,
    );
    assert.deepEqual(messages, [
      "Technician phone activation refused; active configuration unchanged",
    ]);
  }
});

test("production uses exact existing locked atomic runtime and metadata, only capabilities/health/anonymous or invalid-schema probes", () => {
  const source = readFileSync(
    new URL("./enable-production-technician-phone.mjs", import.meta.url),
    "utf8",
  );
  const core = readFileSync(
    new URL("./enable-production-staff-password.mjs", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "productionRuntime(release, false)",
    "await rt.probe(true)",
    "SET TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout",
    "maxWait: 3000, timeout: 5000",
    "log: []",
    'get("/auth/mfa")',
    'get("/auth/technician-phone/capabilities")',
    'body: "{}"',
    "invalid.status !== 400",
    "invariantConfig !== baseline",
  ])
    assert.ok(source.includes(marker), marker);
  for (const marker of [
    "constants.O_NOFOLLOW",
    "constants.O_EXCL",
    "fsyncSync(fd)",
    "fchownSync(fd, 0, gid)",
    "`${BASE}/deploy.lock`",
    "DEPLOY_COMMIT",
    "MainPID",
    "WorkingDirectory",
    "EnvironmentFiles",
    "`/proc/${pid}/cwd`",
    "validateEnv(raw)",
    "rt.checkContext(false)",
  ])
    assert.ok(core.includes(marker), marker);
  assert.doesNotMatch(
    source,
    /SendSms|dysmsapi\.aliyuncs|process\.env|\.user\.create|\.staffMembership\.|password\/set/,
  );
});

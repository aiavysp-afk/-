import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ALIAS_METADATA_QUERY,
  assertAliasMetadata,
  enableStaffPassword,
  inspectStaffEnvironment,
  prepareStaffPasswordEnable,
  prepareStaffPasswordSetupEnable,
  SETUP_METADATA_QUERY,
  assertSetupMetadata,
  runCli,
} from "./enable-production-staff-password.mjs";

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
    "SMS_SEND_ENABLED=true",
    "PHONE_VERIFICATION_SMS_ENABLED=true",
    "CUSTOMER_SMS_LOGIN_ENABLED=true",
    "PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT=20",
    "ALIYUN_SMS_ACCESS_KEY_ID=LTAIunitonlyfixture000000",
    "ALIYUN_SMS_ACCESS_KEY_SECRET=notarealsecretunitfixture000000",
    "ALIYUN_SMS_SIGN_NAME='测试签名'",
    "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE=SMS_UNITONLY",
    "ALIYUN_SMS_SECURITY_TOKEN=''",
    "  export STAFF_PASSWORD_LOGIN_ENABLED = 'false'  # preserve this comment",
    "WECHAT_PAY_PREPAY_ENABLED=true",
    "WECHAT_PAY_REFUND_ENABLED=false",
    "SAFETY_NOTIFICATION_DISPATCH_ENABLED=false",
    "SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED=false",
    "DATABASE_URL='postgresql://unchanged-unit-only' # unchanged",
    "OTHER_CONFIG = '中文 and spaces'",
    "",
  ].join("\r\n"),
);

function fixture(overrides = {}, bytes = original) {
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
    aliasChecks: 0,
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
      const file = files.get(path);
      assert.ok(file, "fixture file exists");
      return { bytes: Buffer.from(file.bytes), stat: { ...file.stat } };
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
      assert.equal(raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT, "20");
      assert.equal(raw.STAFF_MFA_REQUIRED, "true");
      assert.equal(raw.WECHAT_PAY_PREPAY_ENABLED, "true");
      assert.equal(raw.SAFETY_NOTIFICATION_DISPATCH_ENABLED, "false");
    },
    async assertAliasReady() {
      state.aliasChecks++;
    },
    restart() {
      state.restarts++;
      state.running = true;
    },
    async probe(enabled) {
      state.probes.push(enabled);
      assert.equal(state.running, true);
      assert.equal(
        inspectStaffEnvironment(files.get(envPath).bytes).raw
          .STAFF_PASSWORD_LOGIN_ENABLED === "true",
        enabled,
      );
    },
    async pause() {
      state.pauses++;
    },
    ...overrides,
  };
  return { rt, state, files, envPath, safeStat };
}
const activeBytes = (f) => f.files.get(f.envPath).bytes;
const pendingFiles = (f) =>
  [...f.files.keys()].filter((path) => path.endsWith(".pending"));

test("first-password activation changes only the separate setup gate and requires existing password/SMS login", () => {
  const enabled = prepareStaffPasswordEnable(original).bytes;
  const explicit = Buffer.concat([
    enabled,
    Buffer.from("export STAFF_PASSWORD_SETUP_ENABLED = 'false' # keep\r\n"),
  ]);
  const result = prepareStaffPasswordSetupEnable(explicit);
  assert.equal(result.alreadyEnabled, false);
  assert.deepEqual(
    result.bytes,
    Buffer.from(
      explicit
        .toString()
        .replace(
          "STAFF_PASSWORD_SETUP_ENABLED = 'false'",
          "STAFF_PASSWORD_SETUP_ENABLED = true",
        ),
    ),
  );
  assert.equal(result.raw.STAFF_PASSWORD_LOGIN_ENABLED, "true");
  assert.equal(result.raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT, "20");
  assert.deepEqual(
    prepareStaffPasswordSetupEnable(result.bytes).bytes,
    result.bytes,
  );
  const absent = prepareStaffPasswordSetupEnable(enabled).bytes;
  assert.ok(absent.subarray(0, enabled.length).equals(enabled));
  assert.ok(
    absent
      .subarray(enabled.length)
      .equals(Buffer.from("STAFF_PASSWORD_SETUP_ENABLED=true\r\n")),
  );
  assert.throws(() => prepareStaffPasswordSetupEnable(original));
  for (const value of ["1", "yes", "TRUE", "", "undefined"])
    assert.throws(() =>
      prepareStaffPasswordSetupEnable(
        Buffer.concat([
          enabled,
          Buffer.from(`STAFF_PASSWORD_SETUP_ENABLED=${value}\r\n`),
        ]),
      ),
    );
});

test("setup migration checks are metadata-only and require table, columns, FK, indexes and finished migration", () => {
  const keys = [
    "tableReady",
    "columnsReady",
    "foreignKeyReady",
    "indexesReady",
    "migrationReady",
  ];
  const good = Object.fromEntries(keys.map((key) => [key, true]));
  assert.doesNotThrow(() => assertSetupMetadata([good]));
  for (const key of keys)
    assert.throws(() => assertSetupMetadata([{ ...good, [key]: false }]));
  assert.throws(() => assertSetupMetadata([]));
  assert.match(
    SETUP_METADATA_QUERY,
    /20261017060000_staff_password_initial_setup/,
  );
  assert.doesNotMatch(
    SETUP_METADATA_QUERY,
    /SELECT \*|phoneEncrypted|passwordHash|INSERT|UPDATE|DELETE|ALTER/,
  );
});

function setupFixture() {
  const enabled = prepareStaffPasswordEnable(original).bytes;
  let f;
  f = fixture(
    {
      async probe(expected) {
        f.state.probes.push(expected);
        const raw = inspectStaffEnvironment(activeBytes(f)).raw;
        assert.equal(raw.STAFF_PASSWORD_LOGIN_ENABLED, "true");
        assert.equal(raw.STAFF_PASSWORD_SETUP_ENABLED === "true", expected);
      },
    },
    enabled,
  );
  return f;
}

test("setup activation reuses locked atomic backup and rollback without changing main login", async () => {
  const f = setupFixture();
  const before = activeBytes(f);
  const result = await enableStaffPassword({ release, setup: true }, f.rt);
  assert.equal(result.status, "ENABLED");
  assert.deepEqual(
    activeBytes(f),
    prepareStaffPasswordSetupEnable(before).bytes,
  );
  assert.deepEqual(f.files.get(result.backup).bytes, before);
  assert.deepEqual(f.state.probes, [false, true]);
  assert.equal(f.state.restarts, 1);
  assert.equal(f.state.released, true);
  assert.equal(
    (await enableStaffPassword({ release, setup: true }, f.rt)).status,
    "ALREADY_ENABLED",
  );
});

test("failed setup readiness restores exact original bytes and main password login remains open", async () => {
  const f = setupFixture();
  const before = activeBytes(f);
  const probe = f.rt.probe;
  f.rt.probe = async (enabled) => {
    await probe(enabled);
    if (enabled) throw Error("synthetic-readiness-failure");
  };
  await assert.rejects(
    enableStaffPassword({ release, setup: true }, f.rt),
    /restored and verified/,
  );
  assert.deepEqual(activeBytes(f), before);
  assert.equal(
    inspectStaffEnvironment(activeBytes(f)).raw.STAFF_PASSWORD_LOGIN_ENABLED,
    "true",
  );
  assert.deepEqual(f.state.probes, [false, true, true, false]);
  assert.equal(f.state.restarts, 2);
});

test("one gate changes, preserving every unrelated byte, CRLF, comments, daily budget and finance/safety flags", () => {
  const candidate = prepareStaffPasswordEnable(original);
  assert.equal(candidate.alreadyEnabled, false);
  const expected = original
    .toString()
    .replace(
      "STAFF_PASSWORD_LOGIN_ENABLED = 'false'",
      "STAFF_PASSWORD_LOGIN_ENABLED = true",
    );
  assert.deepEqual(candidate.bytes, Buffer.from(expected));
  const before = inspectStaffEnvironment(original).raw;
  assert.deepEqual(
    {
      ...candidate.raw,
      STAFF_PASSWORD_LOGIN_ENABLED: before.STAFF_PASSWORD_LOGIN_ENABLED,
    },
    before,
  );
});

test("absent gate is appended without rewriting prior bytes or enabling anything else", () => {
  const bytes = Buffer.from(
    original
      .toString()
      .replace(/  export STAFF_PASSWORD_LOGIN_ENABLED[^\n]*\n/, "")
      .replace(/\r\n$/, ""),
  );
  const candidate = prepareStaffPasswordEnable(bytes);
  assert.deepEqual(
    candidate.bytes,
    Buffer.concat([
      bytes,
      Buffer.from("\r\nSTAFF_PASSWORD_LOGIN_ENABLED=true\r\n"),
    ]),
  );
});

test("already enabled candidate is byte-identical and keeps custom formatting", () => {
  const bytes = Buffer.from(
    original.toString().replace("'false'  # preserve", "'true'  # preserve"),
  );
  const result = prepareStaffPasswordEnable(bytes);
  assert.equal(result.alreadyEnabled, true);
  assert.deepEqual(result.bytes, bytes);
});

for (const key of [
  "STAFF_BROWSER_LOGIN_ENABLED",
  "STAFF_MFA_REQUIRED",
  "STAFF_TRUSTED_DEVICE_ENABLED",
  "SMS_SEND_ENABLED",
  "PHONE_VERIFICATION_SMS_ENABLED",
  "CUSTOMER_SMS_LOGIN_ENABLED",
])
  test(`refuses disabled/missing required ${key}`, () => {
    for (const value of ["false", ""]) {
      const bytes = Buffer.from(
        original
          .toString()
          .replace(
            `${key}=true`,
            value ? `${key}=${value}` : `# missing ${key}`,
          ),
      );
      assert.throws(() => prepareStaffPasswordEnable(bytes));
    }
  });

test("refuses missing/unbounded/invalid daily budget without defaulting or increasing it", () => {
  for (const value of [
    "",
    "0",
    "10001",
    "999999",
    "1.5",
    "-1",
    "020",
    "not-a-number",
  ]) {
    const bytes = Buffer.from(
      original
        .toString()
        .replace("DAILY_REQUEST_LIMIT=20", `DAILY_REQUEST_LIMIT=${value}`),
    );
    assert.throws(() => prepareStaffPasswordEnable(bytes));
  }
  for (const value of ["1", "10000"]) {
    const bytes = Buffer.from(
      original
        .toString()
        .replace("DAILY_REQUEST_LIMIT=20", `DAILY_REQUEST_LIMIT=${value}`),
    );
    assert.equal(
      prepareStaffPasswordEnable(bytes).raw
        .PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT,
      value,
    );
  }
});

test("refuses invalid provider, environment, credentials, STS or malformed/duplicate env lines", () => {
  for (const [before, after] of [
    ["NODE_ENV=production", "NODE_ENV=test"],
    ["AUTH_PROVIDER=wechat", "AUTH_PROVIDER=mock"],
    ["SMS_PROVIDER=aliyun", "SMS_PROVIDER=none"],
    ["LTAIunitonlyfixture000000", "invalid"],
    ["notarealsecretunitfixture000000", ""],
    ["SMS_UNITONLY", "bad-template"],
    ["ALIYUN_SMS_SECURITY_TOKEN=''", "ALIYUN_SMS_SECURITY_TOKEN=sts-token"],
    ["'false'  # preserve", "'maybe'  # preserve"],
  ])
    assert.throws(() =>
      prepareStaffPasswordEnable(
        Buffer.from(original.toString().replace(before, after)),
      ),
    );
  for (const extra of [
    "export STAFF_PASSWORD_LOGIN_ENABLED = false\n",
    "OTHER_CONFIG=second\n",
    "not an assignment\n",
  ])
    assert.throws(() =>
      prepareStaffPasswordEnable(Buffer.concat([original, Buffer.from(extra)])),
    );
  for (const bad of [
    Buffer.concat([original, Buffer.from([0xff])]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
    Buffer.concat([original, Buffer.from([0])]),
  ])
    assert.throws(() => prepareStaffPasswordEnable(bad));
});

test("metadata assertion requires column, unique valid index, validated check and applied migration", () => {
  const row = {
    columnReady: true,
    indexReady: true,
    constraintReady: true,
    migrationReady: true,
  };
  assert.doesNotThrow(() => assertAliasMetadata([row]));
  for (const key of Object.keys(row))
    assert.throws(() => assertAliasMetadata([{ ...row, [key]: false }]));
  for (const rows of [[], null, [row, row], [{ ...row, columnReady: 1 }]])
    assert.throws(() => assertAliasMetadata(rows));
  assert.match(ALIAS_METADATA_QUERY, /information_schema\.columns/);
  assert.match(
    ALIAS_METADATA_QUERY,
    /finished_at IS NOT NULL AND rolled_back_at IS NULL/,
  );
  assert.doesNotMatch(
    ALIAS_METADATA_QUERY,
    /SELECT \*|phoneEncrypted|passwordHash|INSERT|UPDATE|DELETE|ALTER/,
  );
});

test("successful transaction validates twice, verifies baseline then enabled, preserves gid and exact backup", async () => {
  const f = fixture();
  const result = await enableStaffPassword({ release }, f.rt);
  assert.equal(result.status, "ENABLED");
  assert.deepEqual(activeBytes(f), prepareStaffPasswordEnable(original).bytes);
  assert.deepEqual(f.files.get(result.backup).bytes, original);
  assert.equal(f.files.get(result.backup).stat.gid, 17);
  assert.equal(f.files.get(f.envPath).stat.mode, 0o100600);
  assert.equal(f.state.validations, 2);
  assert.equal(f.state.aliasChecks, 1);
  assert.deepEqual(f.state.probes, [false, true]);
  assert.equal(f.state.restarts, 1);
  assert.deepEqual(pendingFiles(f), []);
  assert.equal(f.state.released, true);
});

test("already enabled path verifies context, alias migration, validation and live probes without writes/restart", async () => {
  const enabled = prepareStaffPasswordEnable(original).bytes;
  const f = fixture({}, enabled);
  assert.deepEqual(await enableStaffPassword({ release }, f.rt), {
    status: "ALREADY_ENABLED",
  });
  assert.deepEqual(activeBytes(f), enabled);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.state.restarts, 0);
  assert.equal(f.state.aliasChecks, 1);
  assert.deepEqual(f.state.probes, [true]);
  assert.equal(f.state.released, true);
});

test("invalid release is rejected before acquiring lock or touching runtime", async () => {
  const f = fixture({
    acquireLock() {
      assert.fail("must not acquire lock");
    },
  });
  for (const bad of [
    "",
    "main",
    "A".repeat(40),
    "a".repeat(39),
    `${release}\n`,
  ])
    await assert.rejects(
      enableStaffPassword({ release: bad }, f.rt),
      /refused/,
    );
  assert.deepEqual(f.state.writes, []);
});

for (const phase of [
  "acquireLock",
  "checkContext",
  "validate",
  "assertAliasReady",
  "probe",
])
  test(`${phase} failure sanitizes errors and never modifies config`, async () => {
    const f = fixture({
      [phase]() {
        throw Error("synthetic-secret-must-not-escape");
      },
    });
    await assert.rejects(enableStaffPassword({ release }, f.rt), (error) => {
      assert.equal(
        error.message,
        "Staff password activation refused; active configuration unchanged",
      );
      return true;
    });
    assert.deepEqual(activeBytes(f), original);
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.state.restarts, 0);
    if (phase !== "acquireLock") assert.equal(f.state.released, true);
  });

test("restart failure allows stopped PID during rollback, restores exact bytes and verifies closed state", async () => {
  const f = fixture();
  f.rt.restart = () => {
    f.state.restarts++;
    f.state.running = f.state.restarts !== 1;
    if (f.state.restarts === 1) throw Error("first restart failed");
  };
  await assert.rejects(
    enableStaffPassword({ release }, f.rt),
    /original configuration restored and verified/,
  );
  assert.deepEqual(activeBytes(f), original);
  assert.equal(f.state.restarts, 2);
  assert.equal(f.state.contexts.filter((value) => value === false).length, 2);
  assert.deepEqual(f.state.probes, [false, false]);
  assert.deepEqual(pendingFiles(f), []);
  assert.equal(f.state.released, true);
});

test("enabled probe failure performs bounded retries then rollback without SMS/password mutation", async () => {
  const f = fixture();
  const probe = f.rt.probe;
  f.rt.probe = async (enabled) => {
    await probe(enabled);
    if (enabled) throw Error("live state mismatch");
  };
  await assert.rejects(
    enableStaffPassword({ release }, f.rt),
    /restored and verified/,
  );
  assert.deepEqual(activeBytes(f), original);
  assert.deepEqual(f.state.probes, [false, true, true, false]);
  assert.equal(f.state.pauses, 1);
  assert.equal(f.state.restarts, 2);
});

test("rollback restart or rollback probe failure is critical, never falsely reports restored", async () => {
  for (const phase of ["restart", "probe"]) {
    const f = fixture();
    if (phase === "restart")
      f.rt.restart = () => {
        f.state.restarts++;
        throw Error("unavailable");
      };
    else {
      const probe = f.rt.probe;
      f.rt.probe = async (enabled) => {
        await probe(enabled);
        if (f.state.restarts) throw Error("unhealthy");
      };
    }
    await assert.rejects(
      enableStaffPassword({ release }, f.rt),
      /CRITICAL: staff password activation rollback requires attention/,
    );
    assert.deepEqual(activeBytes(f), original);
    assert.equal(f.state.released, true);
  }
});

test("outside byte drift before replacement is preserved and only own pending file is removed", async () => {
  const f = fixture();
  const manual = Buffer.concat([original, Buffer.from("MANUAL=true\n")]);
  const context = f.rt.checkContext;
  f.rt.checkContext = (...args) => {
    context(...args);
    if (f.state.contexts.length === 2) f.files.get(f.envPath).bytes = manual;
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /refused/);
  assert.deepEqual(activeBytes(f), manual);
  assert.equal(f.state.restarts, 0);
  assert.equal(f.state.unlinks.length, 1);
  assert.deepEqual(pendingFiles(f), []);
  assert.equal(
    [...f.files.keys()].filter((path) =>
      path.includes(".before-staff-password-"),
    ).length,
    1,
  );
});

test("inode drift before replacement is refused even when bytes match", async () => {
  const f = fixture();
  const context = f.rt.checkContext;
  f.rt.checkContext = (...args) => {
    context(...args);
    if (f.state.contexts.length === 2) f.files.get(f.envPath).stat.ino++;
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /refused/);
  assert.deepEqual(activeBytes(f), original);
  assert.equal(f.state.restarts, 0);
});

test("outside drift after activation is never overwritten by rollback", async () => {
  for (const type of ["bytes", "inode"]) {
    const f = fixture();
    f.rt.restart = () => {
      f.state.restarts++;
      if (type === "bytes")
        f.files.get(f.envPath).bytes = Buffer.from("MANUAL=outside-writer\n");
      else f.files.get(f.envPath).stat.ino++;
      throw Error("outside drift");
    };
    await assert.rejects(enableStaffPassword({ release }, f.rt), /CRITICAL/);
    assert.equal(f.state.restarts, 1);
    assert.equal(f.state.renames.length, 1);
    if (type === "bytes")
      assert.equal(activeBytes(f).toString(), "MANUAL=outside-writer\n");
  }
});

test("lost deployment lock before replacement refuses and cleans own candidate only", async () => {
  const f = fixture();
  const validate = f.rt.validate;
  f.rt.validate = async (raw) => {
    await validate(raw);
    if (f.state.validations === 2) f.state.held = false;
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /refused/);
  assert.deepEqual(activeBytes(f), original);
  assert.equal(f.state.restarts, 0);
  assert.deepEqual(pendingFiles(f), []);
  assert.equal(f.state.released, true);
});

test("lost deployment lock after replacement refuses rollback rather than altering outside authority", async () => {
  const f = fixture();
  f.rt.restart = () => {
    f.state.restarts++;
    f.state.held = false;
    throw Error("lock lost");
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /CRITICAL/);
  assert.deepEqual(activeBytes(f), prepareStaffPasswordEnable(original).bytes);
  assert.equal(f.state.renames.length, 1);
});

test("exclusive write failure never deletes someone else's candidate", async () => {
  const f = fixture();
  const write = f.rt.writeSecure;
  f.rt.writeSecure = (path, bytes, gid) => {
    if (path.endsWith(".pending")) {
      f.files.set(path, {
        bytes: Buffer.from(bytes),
        stat: f.safeStat(bytes.length),
      });
      throw Error("preexisting candidate collision");
    }
    return write(path, bytes, gid);
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /refused/);
  assert.equal(f.state.unlinks.length, 0);
  assert.equal(pendingFiles(f).length, 1);
  assert.deepEqual(activeBytes(f), original);
});

test("tampered pending file is retained, not blindly unlinked", async () => {
  const f = fixture();
  const write = f.rt.writeSecure;
  f.rt.writeSecure = (path, bytes, gid) => {
    const stat = write(path, bytes, gid);
    if (path.endsWith(".pending"))
      f.files.get(path).bytes = Buffer.from("outside modification\n");
    return stat;
  };
  await assert.rejects(enableStaffPassword({ release }, f.rt), /refused/);
  assert.equal(f.state.unlinks.length, 0);
  assert.equal(pendingFiles(f).length, 1);
  assert.deepEqual(activeBytes(f), original);
});

test("CLI rejects extra/secret/path options and does not echo untrusted errors or arguments", async () => {
  for (const args of [
    [],
    ["--confirm-enable-staff-password", "main"],
    ["--confirm-enable-staff-password", release, "--env-file", "/unsafe"],
    ["--confirm-enable-staff-password", release, "synthetic-secret"],
  ]) {
    const lines = [];
    assert.equal(
      await runCli(args, {
        log: (value) => lines.push(value),
        error: (value) => lines.push(value),
      }),
      1,
    );
    assert.deepEqual(lines, [
      "Staff password activation refused; active configuration unchanged",
    ]);
  }
});

test("production adapter pins paths/release, read-only metadata and auth probes, never inherits credentials or calls send/setter endpoints", () => {
  const source = readFileSync(
    new URL("./enable-production-staff-password.mjs", import.meta.url),
    "utf8",
  );
  for (const fragment of [
    "/etc/zhongyuan-daojia/api.env",
    "`${BASE}/deploy.lock`",
    "DEPLOY_COMMIT",
    "WorkingDirectory",
    "EnvironmentFiles",
    "MainPID",
    "`/proc/${pid}/cwd`",
    "constants.O_NOFOLLOW",
    "constants.O_EXCL",
    "fchownSync(fd, 0, gid)",
    '"SET TRANSACTION READ ONLY"',
    "SET LOCAL statement_timeout",
    "maxWait: 3000, timeout: 5000",
    "log: []",
    "validateEnv(raw)",
    'get("/auth/staff-password/config")',
    'get("/auth/trusted-devices/config")',
    'get("/auth/customer-login/capabilities")',
    'get("/auth/browser-login/config")',
    "protectedResponse.status !== 401",
    "t.data?.maxDays !== 7",
    "rt.checkContext(false)",
  ])
    assert.ok(source.includes(fragment), fragment);
  assert.doesNotMatch(
    source,
    /SendSms|dysmsapi\.aliyuncs|sms\/request|process\.env|\.\.\.process\.env|\.user\.create|\.staffMembership\.|password\/set(?!up)/,
  );
  assert.ok(source.includes('body: "{}"'));
  assert.ok(
    source.includes("wrongMethod.status !== 405 || invalid.status !== 400"),
  );
  assert.ok(source.includes("assertSetupMetadata(metadata)"));
  const handshake = source.match(
    /"process\.stdout\.write\('LOCKED[^\"]*"/,
  )?.[0];
  assert.ok(handshake);
  assert.equal(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", JSON.parse(handshake)],
      {
        input: "",
        encoding: "utf8",
        timeout: 3000,
      },
    ),
    "LOCKED\n",
  );
});

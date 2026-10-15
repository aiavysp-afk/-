import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  assertSecureStat,
  parseCredentials,
  prepareCandidate,
  runCli,
  stageSmsCredentials,
} from "./stage-production-sms-credentials.mjs";

const release = "a".repeat(40);
// Synthetic fixtures only, never a usable cloud key.
const credentials = {
  ALIYUN_SMS_ACCESS_KEY_ID: "LTAIunitonlyfixture000000",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "notarealsecretunitfixture000000",
  ALIYUN_SMS_SIGN_NAME: "测试签名",
  ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_UNITONLY",
};
const closed = [
  "SMS_SEND_ENABLED",
  "PHONE_VERIFICATION_SMS_ENABLED",
  "CUSTOMER_SMS_LOGIN_ENABLED",
  "STAFF_PASSWORD_LOGIN_ENABLED",
  "SAFETY_NOTIFICATION_DISPATCH_ENABLED",
  "SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED",
];
const original = Buffer.from(
  [
    "# Existing bytes, whitespace and comments must survive.",
    "NODE_ENV=production",
    "AUTH_PROVIDER=wechat",
    "STAFF_BROWSER_LOGIN_ENABLED=true",
    "SMS_PROVIDER=none",
    ...closed.map((key) => `${key}=false`),
    "STAFF_TRUSTED_DEVICE_ENABLED=true",
    "WECHAT_PAY_PREPAY_ENABLED=true",
    "WECHAT_PAY_REFUND_ENABLED=false",
    "ALIYUN_SMS_SECURITY_TOKEN=''",
    "DATABASE_URL='postgresql://unchanged-unit-only' # preserve comment",
    "OTHER_CONFIG = 'Chinese 中文 and spaces'",
    "",
  ].join("\r\n"),
);

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), "zydj-sms-staging-test-"));
  const absoluteRoot = realpathSync(root);
  assert.ok(absoluteRoot.startsWith(realpathSync(tmpdir()) + sep));
  assert.match(absoluteRoot.split(sep).at(-1), /^zydj-sms-staging-test-/);
  t.after(() => {
    // Delete only the exact temporary directory created for this fixture.
    assert.equal(realpathSync(root), absoluteRoot);
    rmSync(absoluteRoot, { recursive: true });
  });
  const envPath = join(root, "api.env");
  writeFileSync(envPath, original, { mode: 0o600 });
  const state = {
    writes: [],
    renames: [],
    restarts: 0,
    probes: 0,
    validations: 0,
    contexts: 0,
    released: false,
    held: true,
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
    checkContext() {
      state.contexts++;
    },
    readSecure(path) {
      return { bytes: readFileSync(path), stat: statSync(path) };
    },
    writeSecure(path, bytes) {
      state.writes.push(path);
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    },
    rename(from, to) {
      state.renames.push([from, to]);
      renameSync(from, to);
    },
    unlink: unlinkSync,
    syncDirectory() {},
    async validate(raw) {
      state.validations++;
      assert.equal(raw.SMS_PROVIDER, "aliyun");
      assert.equal(
        raw.ALIYUN_SMS_ACCESS_KEY_SECRET,
        credentials.ALIYUN_SMS_ACCESS_KEY_SECRET,
      );
      for (const key of closed) assert.equal(raw[key], "false");
    },
    restart() {
      state.restarts++;
    },
    async probe() {
      state.probes++;
    },
    async pause() {},
    ...changes,
  };
  return { root, envPath, state, rt };
}

test("candidate changes only the five staging keys and preserves unrelated bytes and gates", () => {
  const result = prepareCandidate(original, credentials);
  assert.equal(result.raw.SMS_PROVIDER, "aliyun");
  assert.equal(result.raw.WECHAT_PAY_PREPAY_ENABLED, "true");
  assert.equal(result.raw.STAFF_TRUSTED_DEVICE_ENABLED, "true");
  for (const key of closed) assert.equal(result.raw[key], "false");
  const unrelated = (bytes) =>
    bytes
      .toString()
      .split(/(?<=\n)/)
      .filter(
        (line) =>
          !/^(SMS_PROVIDER|ALIYUN_SMS_ACCESS_KEY_ID|ALIYUN_SMS_ACCESS_KEY_SECRET|ALIYUN_SMS_SIGN_NAME|ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE)=/.test(
            line,
          ),
      );
  assert.deepEqual(unrelated(result.bytes), unrelated(original));
  assert.ok(result.bytes.includes(Buffer.from("\r\n")));
  assert.ok(
    result.bytes.includes(
      Buffer.from(
        "DATABASE_URL='postgresql://unchanged-unit-only' # preserve comment\r\n",
      ),
    ),
  );
});

test("staging validates twice, backs up exact bytes and atomically replaces the same environment path", async (t) => {
  const f = fixture(t);
  const result = await stageSmsCredentials({ release, credentials }, f.rt);
  assert.equal(result.status, "STAGED_SMS_DISABLED");
  assert.deepEqual(readFileSync(result.backup), original);
  assert.deepEqual(
    readFileSync(f.envPath),
    prepareCandidate(original, credentials).bytes,
  );
  assert.equal(f.state.validations, 2);
  assert.equal(f.state.restarts, 1);
  assert.equal(f.state.renames.length, 1);
  assert.equal(f.state.renames[0][1], f.envPath);
  assert.equal(f.state.released, true);
  assert.equal(
    readdirSync(f.root).some((name) => name.endsWith(".pending")),
    false,
  );
});

for (const gate of closed)
  test(`refuses already-open ${gate} without changing it`, () => {
    const bad = Buffer.from(
      original.toString().replace(`${gate}=false`, `${gate}=true`),
    );
    assert.throws(() => prepareCandidate(bad, credentials));
  });

test("missing gates remain absent rather than rewriting unrelated configuration", () => {
  const source = Buffer.from(
    "NODE_ENV=production\nAUTH_PROVIDER=wechat\nSTAFF_BROWSER_LOGIN_ENABLED=true\nSMS_PROVIDER=none",
  );
  const result = prepareCandidate(source, credentials);
  for (const gate of closed)
    assert.equal(Object.hasOwn(result.raw, gate), false);
  assert.ok(
    result.bytes
      .toString()
      .startsWith(
        source.toString().replace("SMS_PROVIDER=none", "SMS_PROVIDER='aliyun'"),
      ),
  );
});

test("duplicate keys including export/whitespace variants and unrelated duplicates are refused", () => {
  for (const duplicate of [
    "export SMS_SEND_ENABLED = false",
    "  SMS_PROVIDER = none",
    "DATABASE_URL=second",
  ])
    assert.throws(() =>
      prepareCandidate(
        Buffer.concat([original, Buffer.from(duplicate + "\n")]),
        credentials,
      ),
    );
});

test("rejects unsafe credential shapes, injection, blank values, STS configuration and invalid UTF8", () => {
  for (const input of [
    { ...credentials, extra: "do-not-accept" },
    { ...credentials, ALIYUN_SMS_SIGN_NAME: "bad\nSMS_SEND_ENABLED=true" },
    { ...credentials, ALIYUN_SMS_SIGN_NAME: "$(not-a-command)" },
    { ...credentials, ALIYUN_SMS_SIGN_NAME: "has'quote" },
    { ...credentials, ALIYUN_SMS_ACCESS_KEY_SECRET: "" },
    { ...credentials, ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "wrong" },
  ])
    assert.throws(() => parseCredentials(input));
  assert.throws(() =>
    prepareCandidate(
      Buffer.from(
        original
          .toString()
          .replace(
            "ALIYUN_SMS_SECURITY_TOKEN=''",
            "ALIYUN_SMS_SECURITY_TOKEN='token'",
          ),
      ),
      credentials,
    ),
  );
  assert.throws(() =>
    prepareCandidate(
      Buffer.concat([original, Buffer.from([0xff])]),
      credentials,
    ),
  );
});

test("file safety rejects symlink, extra permissions, non-root, hardlink and oversize", () => {
  const safe = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100600,
    nlink: 1,
    size: 1024,
  };
  assert.doesNotThrow(() => assertSecureStat(safe));
  for (const modification of [
    { isFile: () => false },
    { isSymbolicLink: () => true },
    { uid: 1000 },
    { mode: 0o100640 },
    { mode: 0o100666 },
    { nlink: 2 },
    { size: 65_537 },
  ])
    assert.throws(() => assertSecureStat({ ...safe, ...modification }));
});

test("candidate schema failure refuses before backup, replace or restart", async (t) => {
  const f = fixture(t, {
    async validate() {
      throw new Error(credentials.ALIYUN_SMS_ACCESS_KEY_SECRET);
    },
  });
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /refused; active configuration unchanged/,
  );
  assert.deepEqual(readFileSync(f.envPath), original);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.state.restarts, 0);
  assert.equal(f.state.released, true);
});

test("release/context or lock failure never replaces configuration", async (t) => {
  for (const changes of [
    {
      checkContext() {
        throw Error("release mismatch");
      },
    },
    {
      async acquireLock() {
        throw Error("lock unavailable");
      },
    },
  ]) {
    const f = fixture(t, changes);
    await assert.rejects(stageSmsCredentials({ release, credentials }, f.rt));
    assert.deepEqual(readFileSync(f.envPath), original);
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.state.restarts, 0);
  }
});

test("restart failure restores original bytes, keeps backup and verifies a second restart", async (t) => {
  const f = fixture(t);
  f.rt.restart = () => {
    f.state.restarts++;
    if (f.state.restarts === 1) throw Error("restart failed");
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /original configuration restored and verified/,
  );
  assert.deepEqual(readFileSync(f.envPath), original);
  assert.equal(f.state.restarts, 2);
  assert.equal(f.state.renames.length, 2);
  const backup = readdirSync(f.root).find((name) =>
    name.includes(".before-sms-"),
  );
  assert.deepEqual(readFileSync(join(f.root, backup)), original);
  assert.equal(f.state.released, true);
});

test("failed closed-capability probe triggers rollback, never an SMS send", async (t) => {
  const f = fixture(t);
  f.rt.probe = async () => {
    f.state.probes++;
    if (f.state.restarts === 1) throw Error("SMS enabled unexpectedly");
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /restored and verified/,
  );
  assert.deepEqual(readFileSync(f.envPath), original);
  assert.equal(f.state.restarts, 2);
  assert.equal(f.state.probes, 4); // baseline + two failed probes + rollback probe
});

test("rollback failure is explicitly critical rather than falsely reported restored", async (t) => {
  const f = fixture(t, {
    restart() {
      throw Error("unavailable");
    },
  });
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /CRITICAL: SMS staging rollback could not be verified/,
  );
  assert.deepEqual(readFileSync(f.envPath), original);
  assert.equal(f.state.released, true);
});

test("manual environment drift before activation is preserved and candidate cleaned", async (t) => {
  const f = fixture(t);
  const manual = Buffer.concat([original, Buffer.from("MANUAL_UPDATE=true\n")]);
  f.rt.checkContext = () => {
    f.state.contexts++;
    if (f.state.contexts === 2) writeFileSync(f.envPath, manual);
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /refused/,
  );
  assert.deepEqual(readFileSync(f.envPath), manual);
  assert.equal(f.state.restarts, 0);
  assert.equal(
    readdirSync(f.root).some((name) => name.endsWith(".pending")),
    false,
  );
});

test("outside writer after activation is not overwritten by rollback", async (t) => {
  const f = fixture(t);
  const manual = Buffer.concat([original, Buffer.from("MANUAL_UPDATE=true\n")]);
  f.rt.restart = () => {
    writeFileSync(f.envPath, manual);
    throw Error("concurrent update");
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /CRITICAL/,
  );
  assert.deepEqual(readFileSync(f.envPath), manual);
});

test("exclusive backup failure and lost deployment lock refuse activation", async (t) => {
  const f = fixture(t);
  f.rt.writeSecure = () => {
    throw Error("exclusive creation refused");
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, f.rt),
    /refused/,
  );
  assert.deepEqual(readFileSync(f.envPath), original);
  const other = fixture(t);
  other.rt.validate = async () => {
    other.state.held = false;
  };
  await assert.rejects(
    stageSmsCredentials({ release, credentials }, other.rt),
    /refused/,
  );
  assert.equal(other.state.restarts, 0);
});

test("CLI refuses missing confirmation and credentials in argv without echoing values", async () => {
  for (const args of [
    [],
    [
      "--confirm-stage-sms-credentials",
      release,
      credentials.ALIYUN_SMS_ACCESS_KEY_SECRET,
    ],
  ]) {
    const messages = [];
    const result = await runCli(args, {
      stdin: Readable.from([JSON.stringify(credentials)]),
      log: (line) => messages.push(line),
      error: (line) => messages.push(line),
    });
    assert.equal(result, 1);
    assert.equal(messages.length, 1);
    assert.equal(
      messages.some((message) =>
        message.includes(credentials.ALIYUN_SMS_ACCESS_KEY_SECRET),
      ),
      false,
    );
  }
});

test("production adapter uses fixed local probes and existing flock, without send endpoints or environment inheritance", () => {
  const source = readFileSync(
    new URL("./stage-production-sms-credentials.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("`${BASE}/deploy.lock`"));
  assert.ok(source.includes('"--no-fork"'));
  assert.ok(source.includes("`http://127.0.0.1:3220/v1${path}`"));
  assert.ok(source.includes('get("/auth/customer-login/capabilities")'));
  assert.ok(source.includes("s.data?.smsEnabled !== false"));
  assert.doesNotMatch(
    source,
    /SendSms|dysmsapi\.aliyuncs|sms\/request|process\.env|\.\.\.process\.env/,
  );
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
        timeout: 3_000,
      },
    ),
    "LOCKED\n",
  );
});

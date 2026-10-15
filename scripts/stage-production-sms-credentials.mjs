// Deliberately stages credentials only. It cannot enable SMS or send a message.
// Run explicitly on the server, never with a credential in argv or an env var.
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const BASE = "/opt/zhongyuan-daojia";
const ENV = "/etc/zhongyuan-daojia/api.env";
const UNIT = "zhongyuan-daojia-api.service";
const CLOSED_GATES = [
  "SMS_SEND_ENABLED",
  "PHONE_VERIFICATION_SMS_ENABLED",
  "CUSTOMER_SMS_LOGIN_ENABLED",
  "STAFF_PASSWORD_LOGIN_ENABLED",
  "SAFETY_NOTIFICATION_DISPATCH_ENABLED",
  "SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED",
];
const CREDENTIAL_KEYS = [
  "ALIYUN_SMS_ACCESS_KEY_ID",
  "ALIYUN_SMS_ACCESS_KEY_SECRET",
  "ALIYUN_SMS_SIGN_NAME",
  "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE",
];
const fail = () => {
  throw new Error("SMS staging precondition failed");
};
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function assertSecureStat(stat) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size > 65_536
  )
    fail();
}

function readSecure(path) {
  const before = lstatSync(path);
  assertSecureStat(before);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSecureStat(opened);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail();
    return { bytes: readFileSync(fd), stat: opened };
  } finally {
    closeSync(fd);
  }
}

function writeSecure(path, bytes, gid) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    fchownSync(fd, 0, gid);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function parseCredentials(input) {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== CREDENTIAL_KEYS.length ||
    CREDENTIAL_KEYS.some((key) => typeof value[key] !== "string")
  )
    fail();
  if (
    !/^LTAI[A-Za-z0-9]{12,124}$/.test(value.ALIYUN_SMS_ACCESS_KEY_ID) ||
    !/^[A-Za-z0-9+/=_-]{16,256}$/.test(value.ALIYUN_SMS_ACCESS_KEY_SECRET) ||
    !/^SMS_[A-Za-z0-9]+$/.test(
      value.ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE,
    ) ||
    value.ALIYUN_SMS_SIGN_NAME.length > 80 ||
    !/^[^\r\n\0'"`$\\#]+$/.test(value.ALIYUN_SMS_SIGN_NAME) ||
    value.ALIYUN_SMS_SIGN_NAME.trim() !== value.ALIYUN_SMS_SIGN_NAME
  )
    fail();
  return Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, value[key]]));
}

function inspectEnvironment(bytes) {
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text).equals(bytes) ||
    text.includes("\0") ||
    text.startsWith("\ufeff")
  )
    fail();
  const records = text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  const keys = new Set();
  for (const record of records) {
    const match = record.match(
      /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/,
    );
    if (match) {
      if (keys.has(match[1])) fail();
      keys.add(match[1]);
    } else if (record.trim() && !record.trimStart().startsWith("#")) fail();
  }
  const raw = parseEnv(text);
  if (
    raw.NODE_ENV !== "production" ||
    raw.AUTH_PROVIDER !== "wechat" ||
    raw.STAFF_BROWSER_LOGIN_ENABLED !== "true" ||
    !["none", "aliyun"].includes(raw.SMS_PROVIDER) ||
    (raw.ALIYUN_SMS_SECURITY_TOKEN ?? "") !== "" ||
    CLOSED_GATES.some((key) => ![undefined, "false"].includes(raw[key]))
  )
    fail();
  return { records, keys, raw };
}

export function prepareCandidate(original, supplied) {
  const credentials = parseCredentials(supplied);
  const inspected = inspectEnvironment(original);
  const changes = { SMS_PROVIDER: "aliyun", ...credentials };
  let text = inspected.records
    .map((record) => {
      const match = record.match(
        /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=).*?(\r?\n|$)$/,
      );
      return match && Object.hasOwn(changes, match[2])
        ? `${match[1]}${match[2]}${match[3]}'${changes[match[2]]}'${match[4]}`
        : record;
    })
    .join("");
  const missing = Object.keys(changes).filter(
    (key) => !inspected.keys.has(key),
  );
  if (missing.length) {
    const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    if (text && !text.endsWith("\n")) text += newline;
    text += missing.map((key) => `${key}='${changes[key]}'${newline}`).join("");
  }
  const bytes = Buffer.from(text);
  const next = inspectEnvironment(bytes).raw;
  for (const key of Object.keys(inspected.raw))
    if (!Object.hasOwn(changes, key) && next[key] !== inspected.raw[key])
      fail();
  for (const key of Object.keys(changes))
    if (next[key] !== changes[key]) fail();
  return { bytes, raw: next };
}

// flock lives in a helper with an open stdin. Parent exit closes stdin and releases
// the lock; no credentials or API environment are inherited by this helper.
function acquireDeployLock() {
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      "--no-fork",
      `${BASE}/deploy.lock`,
      process.execPath,
      "--input-type=module",
      "-e",
      "process.stdout.write('LOCKED\\n');process.stdin.resume();",
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
  );
  let held = false;
  child.on("exit", () => {
    held = false;
  });
  child.stdin.on("error", () => {
    held = false;
  });
  return new Promise((resolveLock, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Deployment lock unavailable"));
    }, 3_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Deployment lock unavailable"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Deployment lock unavailable"));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output === "LOCKED\n") {
        clearTimeout(timer);
        held = true;
        resolveLock({
          assertHeld() {
            if (!held || child.exitCode !== null) fail();
          },
          async release() {
            if (child.exitCode !== null) return;
            await new Promise((done) => {
              child.once("exit", done);
              child.stdin.end();
            });
          },
        });
      }
    });
  });
}

function productionRuntime(release) {
  const expected = `${BASE}/releases/${release}`;
  const systemctl = (...args) =>
    execFileSync("/usr/bin/systemctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    }).trim();
  function checkContext() {
    if (
      process.getuid?.() !== 0 ||
      realpathSync(`${BASE}/current`) !== expected ||
      readFileSync(`${expected}/DEPLOY_COMMIT`, "utf8").trim() !== release ||
      realpathSync(dirname(ENV)) !== dirname(ENV)
    )
      fail();
    const parent = lstatSync(dirname(ENV));
    if (parent.uid !== 0 || (parent.mode & 0o022) !== 0) fail();
    if (
      systemctl("show", UNIT, "-p", "WorkingDirectory", "--value") !==
        `${BASE}/current/apps/api` ||
      !systemctl("show", UNIT, "-p", "EnvironmentFiles", "--value")
        .split(/\s+/)
        .includes(ENV)
    )
      fail();
    const pid = systemctl("show", UNIT, "-p", "MainPID", "--value");
    if (
      !/^[1-9][0-9]*$/.test(pid) ||
      realpathSync(`/proc/${pid}/cwd`) !== `${expected}/apps/api`
    )
      fail();
  }
  async function probe() {
    checkContext();
    const get = (path) =>
      fetch(`http://127.0.0.1:3220/v1${path}`, {
        signal: AbortSignal.timeout(1_000),
        redirect: "error",
      });
    const [health, customer, staff, browser, protectedRoute] =
      await Promise.all([
        get("/health"),
        get("/auth/customer-login/capabilities"),
        get("/auth/staff-password/config"),
        get("/auth/browser-login/config"),
        get("/auth/trusted-devices"),
      ]);
    if (
      health.status !== 200 ||
      customer.status !== 200 ||
      staff.status !== 200 ||
      browser.status !== 200 ||
      protectedRoute.status !== 401
    )
      fail();
    const [c, s, b] = await Promise.all([
      customer.json(),
      staff.json(),
      browser.json(),
    ]);
    if (
      c.data?.wechatPhoneLoginEnabled !== true ||
      c.data?.smsLoginEnabled !== false ||
      s.data?.enabled !== false ||
      s.data?.smsEnabled !== false ||
      b.data?.enabled !== true ||
      b.data?.provider !== "wechat"
    )
      fail();
  }
  return {
    envPath: ENV,
    acquireLock: acquireDeployLock,
    checkContext,
    readSecure,
    writeSecure,
    rename: renameSync,
    unlink: unlinkSync,
    syncDirectory,
    async validate(raw) {
      const { validateEnv } = await import(
        pathToFileURL(`${expected}/apps/api/dist/config/env.js`).href
      );
      validateEnv(raw);
    },
    restart() {
      systemctl("restart", UNIT);
    },
    probe,
    pause: () => new Promise((done) => setTimeout(done, 500)),
    attempts: 20,
  };
}

export async function stageSmsCredentials({ release, credentials }, runtime) {
  // Injection is for local tests only; the CLI always uses fixed production paths.
  if (!/^[a-f0-9]{40}$/.test(release ?? "")) fail();
  const rt = runtime ?? productionRuntime(release);
  const lock = await rt.acquireLock();
  let original,
    candidate,
    backup,
    pending,
    changed = false;
  const nonce = randomUUID();
  async function verify() {
    for (let attempt = 0; attempt < rt.attempts; attempt++) {
      try {
        lock.assertHeld();
        await rt.probe();
        return;
      } catch {
        /* bounded convergence */
      }
      if (attempt + 1 < rt.attempts) await rt.pause();
    }
    fail();
  }
  try {
    lock.assertHeld();
    rt.checkContext();
    original = rt.readSecure(rt.envPath);
    candidate = prepareCandidate(original.bytes, credentials);
    await rt.validate(candidate.raw);
    await verify();
    backup = `${rt.envPath}.before-sms-${nonce}`;
    pending = `${rt.envPath}.sms-${nonce}.pending`;
    rt.writeSecure(backup, original.bytes, original.stat.gid);
    if (!sameBytes(rt.readSecure(backup).bytes, original.bytes)) fail();
    rt.writeSecure(pending, candidate.bytes, original.stat.gid);
    rt.syncDirectory(pending);
    const written = rt.readSecure(pending);
    if (!sameBytes(written.bytes, candidate.bytes)) fail();
    await rt.validate(inspectEnvironment(written.bytes).raw);
    lock.assertHeld();
    rt.checkContext();
    const active = rt.readSecure(rt.envPath);
    if (
      !sameBytes(active.bytes, original.bytes) ||
      active.stat.ino !== original.stat.ino ||
      active.stat.dev !== original.stat.dev
    )
      fail();
    rt.rename(pending, rt.envPath);
    pending = undefined;
    changed = true;
    rt.syncDirectory(rt.envPath);
    rt.restart();
    await verify();
    if (!sameBytes(rt.readSecure(rt.envPath).bytes, candidate.bytes)) fail();
    return { status: "STAGED_SMS_DISABLED", backup };
  } catch {
    if (changed && original && candidate) {
      try {
        lock.assertHeld();
        if (!sameBytes(rt.readSecure(rt.envPath).bytes, candidate.bytes))
          fail();
        pending = `${rt.envPath}.sms-rollback-${nonce}.pending`;
        rt.writeSecure(pending, original.bytes, original.stat.gid);
        rt.rename(pending, rt.envPath);
        pending = undefined;
        rt.syncDirectory(rt.envPath);
        rt.restart();
        await verify();
        if (!sameBytes(rt.readSecure(rt.envPath).bytes, original.bytes)) fail();
      } catch {
        throw new Error("CRITICAL: SMS staging rollback could not be verified");
      }
      throw new Error(
        "SMS staging failed; original configuration restored and verified",
      );
    }
    throw new Error("SMS staging refused; active configuration unchanged");
  } finally {
    if (pending) {
      try {
        rt.unlink(pending);
      } catch {
        /* do not mask a rollback failure */
      }
    }
    await lock.release();
  }
}

export async function runCli(
  args,
  io = { stdin: process.stdin, log: console.log, error: console.error },
) {
  try {
    if (
      args[0] !== "--confirm-stage-sms-credentials" ||
      !/^[a-f0-9]{40}$/.test(args[1] ?? "") ||
      ![2, 4].includes(args.length) ||
      (args.length === 4 &&
        (args[2] !== "--credentials-file" || !isAbsolute(args[3]))) ||
      process.getuid?.() !== 0
    )
      fail();
    let bytes;
    if (args.length === 4) bytes = readSecure(args[3]).bytes;
    else {
      if (io.stdin.isTTY) fail();
      const chunks = [];
      let length = 0;
      for await (const chunk of io.stdin) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 8_192) fail();
        chunks.push(buffer);
      }
      bytes = Buffer.concat(chunks);
    }
    const credentials = parseCredentials(bytes.toString("utf8"));
    await stageSmsCredentials({ release: args[1], credentials });
    io.log(
      "SMS credentials staged and verified. All SMS sending/login gates remain closed; no SMS sent.",
    );
    return 0;
  } catch (error) {
    // Do not log thrown errors: provider/schema/JSON errors may contain secrets.
    const safeMessages = new Set([
      "SMS staging refused; active configuration unchanged",
      "SMS staging failed; original configuration restored and verified",
      "CRITICAL: SMS staging rollback could not be verified",
    ]);
    io.error(
      safeMessages.has(error?.message)
        ? error.message
        : "SMS staging refused; configuration was not staged",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runCli(process.argv.slice(2));

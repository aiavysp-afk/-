// Explicit, bounded activation after credentials are staged. Never sends SMS.
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { parseEnv } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  assertSecureStat,
  parseCredentials,
} from "./stage-production-sms-credentials.mjs";

const base = "/opt/zhongyuan-daojia";
const envPath = "/etc/zhongyuan-daojia/api.env";
const unit = "zhongyuan-daojia-api.service";
const sendingGates = [
  "SMS_SEND_ENABLED",
  "PHONE_VERIFICATION_SMS_ENABLED",
  "CUSTOMER_SMS_LOGIN_ENABLED",
];
const remainClosed = [
  "STAFF_PASSWORD_LOGIN_ENABLED",
  "SAFETY_NOTIFICATION_DISPATCH_ENABLED",
  "SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED",
];
const fail = () => {
  throw new Error("Customer SMS activation refused");
};
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function prepareCustomerSmsEnable(original, dailyLimit) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000)
    fail();
  const text = original.toString("utf8");
  if (
    !Buffer.from(text).equals(original) ||
    text.includes("\0") ||
    text.startsWith("\ufeff")
  )
    fail();
  const records = text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  const seen = new Set();
  for (const record of records) {
    const m = record.match(
      /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/,
    );
    if (m) {
      if (seen.has(m[1])) fail();
      seen.add(m[1]);
    } else if (record.trim() && !record.trimStart().startsWith("#")) fail();
  }
  const before = parseEnv(text);
  if (
    before.NODE_ENV !== "production" ||
    before.AUTH_PROVIDER !== "wechat" ||
    before.SMS_PROVIDER !== "aliyun" ||
    before.STAFF_BROWSER_LOGIN_ENABLED !== "true" ||
    (before.ALIYUN_SMS_SECURITY_TOKEN ?? "") !== "" ||
    [...sendingGates, ...remainClosed].some(
      (key) => ![undefined, "false"].includes(before[key]),
    )
  )
    fail();
  parseCredentials(
    Object.fromEntries(
      [
        "ALIYUN_SMS_ACCESS_KEY_ID",
        "ALIYUN_SMS_ACCESS_KEY_SECRET",
        "ALIYUN_SMS_SIGN_NAME",
        "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE",
      ].map((key) => [key, before[key]]),
    ),
  );
  const changes = {
    ...Object.fromEntries(sendingGates.map((key) => [key, "true"])),
    PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT: String(dailyLimit),
  };
  let result = records
    .map((record) => {
      const m = record.match(
        /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=).*?(\r?\n|$)$/,
      );
      return m && Object.hasOwn(changes, m[2])
        ? `${m[1]}${m[2]}${m[3]}'${changes[m[2]]}'${m[4]}`
        : record;
    })
    .join("");
  const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
  if (result && !result.endsWith("\n")) result += newline;
  result += Object.keys(changes)
    .filter((key) => !seen.has(key))
    .map((key) => `${key}='${changes[key]}'${newline}`)
    .join("");
  const after = parseEnv(result);
  for (const key of Object.keys(before))
    if (!Object.hasOwn(changes, key) && before[key] !== after[key]) fail();
  for (const key of Object.keys(changes))
    if (after[key] !== changes[key]) fail();
  return { bytes: Buffer.from(result), raw: after };
}

function readSecure(path) {
  const before = lstatSync(path);
  assertSecureStat(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assertSecureStat(stat);
    if (stat.ino !== before.ino || stat.dev !== before.dev) fail();
    return { bytes: readFileSync(fd), stat };
  } finally {
    closeSync(fd);
  }
}
function writeSecure(path, bytes) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncConfigDirectory() {
  const fd = openSync(
    "/etc/zhongyuan-daojia",
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function activate(release, limit) {
  const expected = `${base}/releases/${release}`;
  const ctl = (...args) =>
    execFileSync("/usr/bin/systemctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      env: { PATH: "/usr/bin:/bin" },
    }).trim();
  function context(requireRunning = true) {
    if (
      process.getuid?.() !== 0 ||
      realpathSync(`${base}/current`) !== expected ||
      readFileSync(`${expected}/DEPLOY_COMMIT`, "utf8").trim() !== release ||
      realpathSync("/etc/zhongyuan-daojia") !== "/etc/zhongyuan-daojia"
    )
      fail();
    const parent = lstatSync("/etc/zhongyuan-daojia");
    if (
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0 ||
      ctl("show", unit, "-p", "WorkingDirectory", "--value") !==
        `${base}/current/apps/api` ||
      !ctl("show", unit, "-p", "EnvironmentFiles", "--value")
        .split(/\s+/)
        .includes(envPath)
    )
      fail();
    if (
      !existsSync(
        `${expected}/apps/api/dist/integrations/phone-verification-sms-budget.service.js`,
      )
    )
      fail();
    if (requireRunning) {
      const pid = ctl("show", unit, "-p", "MainPID", "--value");
      if (
        !/^[1-9][0-9]*$/.test(pid) ||
        realpathSync(`/proc/${pid}/cwd`) !== `${expected}/apps/api`
      )
        fail();
    }
  }
  async function probe(enabled) {
    context();
    const get = (path) =>
      fetch(`http://127.0.0.1:3220/v1${path}`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
    const [health, customer, staff, browser, protectedResponse] =
      await Promise.all([
        get("/health"),
        get("/auth/customer-login/capabilities"),
        get("/auth/staff-password/config"),
        get("/auth/browser-login/config"),
        get("/auth/trusted-devices"),
      ]);
    if (
      [health, customer, staff, browser].some((r) => r.status !== 200) ||
      protectedResponse.status !== 401
    )
      fail();
    const [c, s, b] = await Promise.all([
      customer.json(),
      staff.json(),
      browser.json(),
    ]);
    if (
      c.data?.wechatPhoneLoginEnabled !== true ||
      c.data?.smsLoginEnabled !== enabled ||
      s.data?.enabled !== false ||
      s.data?.smsEnabled !== false ||
      b.data?.enabled !== true ||
      b.data?.provider !== "wechat"
    )
      fail();
  }
  const lock = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      "--no-fork",
      `${base}/deploy.lock`,
      process.execPath,
      "--input-type=module",
      "-e",
      "process.stdout.write('LOCKED\\n');process.stdin.resume();",
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
  );
  let held = false;
  lock.on("exit", () => {
    held = false;
  });
  lock.stdin.on("error", () => {
    held = false;
  });
  await new Promise((yes, no) => {
    const timer = setTimeout(() => {
      lock.kill();
      no(new Error("Lock unavailable"));
    }, 3000);
    lock.once("error", () => {
      clearTimeout(timer);
      no(new Error("Lock unavailable"));
    });
    lock.once("exit", () => {
      clearTimeout(timer);
      no(new Error("Lock unavailable"));
    });
    let output = "";
    lock.stdout.on("data", (d) => {
      output += d;
      if (output === "LOCKED\n") {
        clearTimeout(timer);
        held = true;
        yes();
      }
    });
  });
  const assertHeld = () => {
    if (!held || lock.exitCode !== null) fail();
  };
  const verify = async (enabled) => {
    for (let i = 0; i < 20; i++) {
      try {
        assertHeld();
        await probe(enabled);
        return;
      } catch {
        /* bounded restart convergence */
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    fail();
  };
  let original,
    candidate,
    changed = false;
  try {
    assertHeld();
    context();
    original = readSecure(envPath);
    candidate = prepareCustomerSmsEnable(original.bytes, limit);
    const { validateEnv } = await import(
      pathToFileURL(`${expected}/apps/api/dist/config/env.js`).href
    );
    validateEnv(candidate.raw);
    await verify(false);
    const nonce = randomUUID();
    const backup = `${envPath}.before-customer-sms-${nonce}`;
    const pending = `${envPath}.customer-sms-${nonce}.pending`;
    writeSecure(backup, original.bytes);
    if (!same(readSecure(backup).bytes, original.bytes)) fail();
    writeSecure(pending, candidate.bytes);
    syncConfigDirectory();
    if (!same(readSecure(pending).bytes, candidate.bytes)) fail();
    validateEnv(parseEnv(readSecure(pending).bytes.toString("utf8")));
    assertHeld();
    context();
    const current = readSecure(envPath);
    if (
      !same(current.bytes, original.bytes) ||
      current.stat.ino !== original.stat.ino ||
      current.stat.dev !== original.stat.dev
    )
      fail();
    renameSync(pending, envPath);
    changed = true;
    syncConfigDirectory();
    ctl("restart", unit);
    await verify(true);
    if (!same(readSecure(envPath).bytes, candidate.bytes)) fail();
  } catch {
    if (changed) {
      try {
        assertHeld();
        context(false);
        if (!same(readSecure(envPath).bytes, candidate.bytes)) fail();
        const rollback = `${envPath}.customer-sms-rollback-${randomUUID()}.pending`;
        writeSecure(rollback, original.bytes);
        renameSync(rollback, envPath);
        syncConfigDirectory();
        ctl("restart", unit);
        await verify(false);
        if (!same(readSecure(envPath).bytes, original.bytes)) fail();
      } catch {
        throw new Error("CRITICAL: customer SMS rollback requires attention");
      }
      throw new Error(
        "Customer SMS activation failed; original closed configuration restored",
      );
    }
    fail();
  } finally {
    if (lock.exitCode === null)
      await new Promise((done) => {
        lock.once("exit", done);
        lock.stdin.end();
      });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  try {
    if (
      args.length !== 4 ||
      args[0] !== "--confirm-enable-customer-sms" ||
      !/^[a-f0-9]{40}$/.test(args[1]) ||
      args[2] !== "--daily-limit" ||
      !/^[1-9][0-9]{0,4}$/.test(args[3]) ||
      Number(args[3]) > 10000
    )
      fail();
    await activate(args[1], Number(args[3]));
    console.log(
      `Customer SMS login enabled and verified; daily request limit ${Number(args[3])}; no SMS sent.`,
    );
  } catch (error) {
    const safe = [
      "CRITICAL: customer SMS rollback requires attention",
      "Customer SMS activation failed; original closed configuration restored",
    ];
    console.error(
      safe.includes(error?.message)
        ? error.message
        : "Customer SMS activation refused; check preconditions without logging secrets",
    );
    process.exitCode = 1;
  }
}

// Explicit activation only: no users, credentials, roles or SMS are created.
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
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  assertSecureStat,
  parseCredentials,
} from "./stage-production-sms-credentials.mjs";

const BASE = "/opt/zhongyuan-daojia";
const ENV = "/etc/zhongyuan-daojia/api.env";
const UNIT = "zhongyuan-daojia-api.service";
const GATE = "STAFF_PASSWORD_LOGIN_ENABLED";
const SETUP_GATE = "STAFF_PASSWORD_SETUP_ENABLED";
const MIGRATION = "20261016040000_staff_password_login_alias";
const SETUP_MIGRATION = "20261017060000_staff_password_initial_setup";
const REFUSED =
  "Staff password activation refused; active configuration unchanged";
const RESTORED =
  "Staff password activation failed; original configuration restored and verified";
const CRITICAL =
  "CRITICAL: staff password activation rollback requires attention";
const fail = () => {
  throw new Error("Staff password activation precondition failed");
};
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function inspectStaffEnvironment(bytes) {
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
  for (const key of [
    "STAFF_BROWSER_LOGIN_ENABLED",
    "STAFF_MFA_REQUIRED",
    "STAFF_TRUSTED_DEVICE_ENABLED",
    "SMS_SEND_ENABLED",
    "PHONE_VERIFICATION_SMS_ENABLED",
    "CUSTOMER_SMS_LOGIN_ENABLED",
  ])
    if (raw[key] !== "true") fail();
  if (
    raw.NODE_ENV !== "production" ||
    raw.AUTH_PROVIDER !== "wechat" ||
    raw.SMS_PROVIDER !== "aliyun" ||
    ![undefined, "false", "true"].includes(raw[GATE]) ||
    ![undefined, "false", "true"].includes(raw[SETUP_GATE]) ||
    (raw[SETUP_GATE] === "true" && raw[GATE] !== "true") ||
    (raw.ALIYUN_SMS_SECURITY_TOKEN ?? "") !== "" ||
    !/^[1-9][0-9]{0,4}$/.test(
      raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT ?? "",
    ) ||
    Number(raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT) > 10000
  )
    fail();
  parseCredentials(
    Object.fromEntries(
      [
        "ALIYUN_SMS_ACCESS_KEY_ID",
        "ALIYUN_SMS_ACCESS_KEY_SECRET",
        "ALIYUN_SMS_SIGN_NAME",
        "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE",
      ].map((key) => [key, raw[key]]),
    ),
  );
  return { records, keys, raw };
}

export function prepareStaffPasswordEnable(original) {
  return prepareStaffGate(original, GATE);
}

export function prepareStaffPasswordSetupEnable(original) {
  if (inspectStaffEnvironment(original).raw[GATE] !== "true") fail();
  return prepareStaffGate(original, SETUP_GATE);
}

function prepareStaffGate(original, gate) {
  if (![GATE, SETUP_GATE].includes(gate)) fail();
  const before = inspectStaffEnvironment(original);
  if (before.raw[gate] === "true")
    return {
      bytes: Buffer.from(original),
      raw: before.raw,
      alreadyEnabled: true,
    };
  let text = before.records
    .map((record) => {
      if (!new RegExp(`^[ \\t]*(?:export[ \\t]+)?${gate}[ \\t]*=`).test(record))
        return record;
      // Only the value changes; whitespace, inline comment and newline survive.
      const match = record.match(
        new RegExp(
          `^([ \\t]*(?:export[ \\t]+)?${gate}[ \\t]*=[ \\t]*)(?:false|'false'|"false")([ \\t]*(?:#[^\\r\\n]*)?)(\\r?\\n|$)$`,
        ),
      );
      if (!match) fail();
      return `${match[1]}true${match[2]}${match[3]}`;
    })
    .join("");
  if (!before.keys.has(gate)) {
    const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    if (text && !text.endsWith("\n")) text += newline;
    text += `${gate}=true${newline}`;
  }
  const bytes = Buffer.from(text);
  const after = inspectStaffEnvironment(bytes).raw;
  if (after[gate] !== "true") fail();
  for (const key of new Set([
    ...Object.keys(before.raw),
    ...Object.keys(after),
  ]))
    if (key !== gate && before.raw[key] !== after[key]) fail();
  return { bytes, raw: after, alreadyEnabled: false };
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
function writeSecure(path, bytes, gid) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const created = fstatSync(fd);
  try {
    fchmodSync(fd, 0o600);
    fchownSync(fd, 0, gid);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    return fstatSync(fd);
  } catch (error) {
    try {
      const current = lstatSync(path);
      if (current.ino === created.ino && current.dev === created.dev)
        unlinkSync(path);
    } catch {
      /* never remove a replacement file */
    }
    throw error;
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
  return new Promise((yes, no) => {
    const reject = () => {
      clearTimeout(timer);
      no(new Error("Deployment lock unavailable"));
    };
    const timer = setTimeout(() => {
      child.kill();
      reject();
    }, 3000);
    child.once("error", reject);
    child.once("exit", reject);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output === "LOCKED\n") {
        clearTimeout(timer);
        held = true;
        yes({
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

// Metadata only, inside a read-only transaction; no account/phone rows are read.
export const ALIAS_METADATA_QUERY = `SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'StaffPasswordCredential' AND column_name = 'loginAlias'
    AND data_type = 'text' AND is_nullable = 'YES') AS "columnReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'StaffPasswordCredential'
    AND x.relname = 'StaffPasswordCredential_loginAlias_key' AND i.indisunique AND i.indisvalid) AS "indexReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public'
    AND t.relname = 'StaffPasswordCredential' AND c.conname = 'StaffPasswordCredential_loginAlias_format_check'
    AND c.contype = 'c' AND c.convalidated) AS "constraintReady",
  EXISTS (SELECT 1 FROM public."_prisma_migrations" WHERE migration_name = '${MIGRATION}'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationReady"`;

export function assertAliasMetadata(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    ["columnReady", "indexReady", "constraintReady", "migrationReady"].some(
      (key) => rows[0]?.[key] !== true,
    )
  )
    fail();
}

export const SETUP_METADATA_QUERY = `SELECT
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public'
    AND table_name='StaffPasswordSetupChallenge') AS "tableReady",
  (SELECT count(*) = 12 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='StaffPasswordSetupChallenge' AND column_name IN
    ('id','userId','phoneHash','secretHash','codeHash','status','attempts','expiresAt','createdAt','consumedAt','providerRequestId','providerBizId')) AS "columnsReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='StaffPasswordSetupChallenge' AND c.conname='StaffPasswordSetupChallenge_userId_fkey'
    AND c.contype='f' AND c.convalidated) AS "foreignKeyReady",
  (SELECT count(*) = 2 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='StaffPasswordSetupChallenge' AND i.indisvalid
    AND x.relname IN ('StaffPasswordSetupChallenge_userId_createdAt_idx','StaffPasswordSetupChallenge_expiresAt_idx')) AS "indexesReady",
  EXISTS (SELECT 1 FROM public."_prisma_migrations" WHERE migration_name='${SETUP_MIGRATION}'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationReady"`;

export function assertSetupMetadata(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    [
      "tableReady",
      "columnsReady",
      "foreignKeyReady",
      "indexesReady",
      "migrationReady",
    ].some((key) => rows[0]?.[key] !== true)
  )
    fail();
}

function productionRuntime(release, setup) {
  const expected = `${BASE}/releases/${release}`;
  const ctl = (...args) =>
    execFileSync("/usr/bin/systemctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      env: { PATH: "/usr/bin:/bin" },
    }).trim();
  function checkContext(requireRunning = true) {
    if (
      process.getuid?.() !== 0 ||
      realpathSync(`${BASE}/current`) !== expected ||
      readFileSync(`${expected}/DEPLOY_COMMIT`, "utf8").trim() !== release ||
      realpathSync(dirname(ENV)) !== dirname(ENV)
    )
      fail();
    const parent = lstatSync(dirname(ENV));
    if (
      !parent.isDirectory() ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0 ||
      ctl("show", UNIT, "-p", "WorkingDirectory", "--value") !==
        `${BASE}/current/apps/api` ||
      !ctl("show", UNIT, "-p", "EnvironmentFiles", "--value")
        .split(/\s+/)
        .includes(ENV)
    )
      fail();
    if (requireRunning) {
      const pid = ctl("show", UNIT, "-p", "MainPID", "--value");
      if (
        !/^[1-9][0-9]*$/.test(pid) ||
        realpathSync(`/proc/${pid}/cwd`) !== `${expected}/apps/api`
      )
        fail();
    }
  }
  async function assertAliasReady(raw) {
    const service = readFileSync(
      `${expected}/apps/api/dist/auth/staff-password.service.js`,
      "utf8",
    );
    const account = readFileSync(
      `${expected}/apps/api/dist/auth/staff-login-account.js`,
      "utf8",
    );
    const controller = readFileSync(
      `${expected}/apps/api/dist/auth/staff-password.controller.js`,
      "utf8",
    );
    if (
      !service.includes("normalizeStaffLoginAccount") ||
      !service.includes("loginAlias") ||
      !account.includes("normalizeStaffLoginAlias") ||
      !controller.includes("loginAlias")
    )
      fail();
    const requireApi = createRequire(`${expected}/apps/api/package.json`);
    const { PrismaClient } = requireApi("@prisma/client");
    const prisma = new PrismaClient({
      datasources: { db: { url: raw.DATABASE_URL } },
      log: [],
    });
    try {
      const rows = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
          return tx.$queryRawUnsafe(ALIAS_METADATA_QUERY);
        },
        { maxWait: 3000, timeout: 5000 },
      );
      assertAliasMetadata(rows);
      if (setup) {
        const metadata = await prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
            await tx.$executeRawUnsafe(
              "SET LOCAL statement_timeout = '3000ms'",
            );
            return tx.$queryRawUnsafe(SETUP_METADATA_QUERY);
          },
          { maxWait: 3000, timeout: 5000 },
        );
        assertSetupMetadata(metadata);
        const setupService = readFileSync(
          `${expected}/apps/api/dist/auth/staff-password-setup.service.js`,
          "utf8",
        );
        if (
          !service.includes(SETUP_GATE) ||
          !setupService.includes("StaffPasswordSetupService") ||
          !setupService.includes("setupEnabled")
        )
          fail();
      }
    } finally {
      await prisma.$disconnect();
    }
  }
  async function probe(enabled) {
    checkContext();
    const get = (path) =>
      fetch(`http://127.0.0.1:3220/v1${path}`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
    const [health, customer, staff, browser, trust, protectedResponse] =
      await Promise.all([
        get("/health"),
        get("/auth/customer-login/capabilities"),
        get("/auth/staff-password/config"),
        get("/auth/browser-login/config"),
        get("/auth/trusted-devices/config"),
        get("/auth/trusted-devices"),
      ]);
    if (
      [health, customer, staff, browser, trust].some((r) => r.status !== 200) ||
      protectedResponse.status !== 401
    )
      fail();
    const [c, s, b, t] = await Promise.all([
      customer.json(),
      staff.json(),
      browser.json(),
      trust.json(),
    ]);
    if (
      c.data?.wechatPhoneLoginEnabled !== true ||
      c.data?.smsLoginEnabled !== true ||
      s.data?.enabled !== (setup ? true : enabled) ||
      s.data?.smsEnabled !== (setup ? true : enabled) ||
      (setup && s.data?.setupEnabled !== enabled) ||
      b.data?.enabled !== true ||
      b.data?.provider !== "wechat" ||
      t.data?.enabled !== true ||
      t.data?.maxDays !== 7
    )
      fail();
    if (setup) {
      // Invalid empty bodies stop in strict validation: no phone, OTP, or
      // password is supplied and no SMS/account write is possible.
      for (const action of ["request", "confirm"]) {
        const url = `http://127.0.0.1:3222/v1/auth/staff-password/setup/${action}`;
        const wrongMethod = await fetch(url, {
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        });
        const invalid = await fetch(url, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(1500),
          redirect: "error",
          headers: {
            Origin: "https://admin.mtsc.top",
            "Content-Type": "application/json",
          },
        });
        if (wrongMethod.status !== 405 || invalid.status !== 400) fail();
      }
    }
  }
  return {
    envPath: ENV,
    acquireLock: acquireDeployLock,
    checkContext,
    assertAliasReady,
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
      ctl("restart", UNIT);
    },
    probe,
    pause: () => new Promise((done) => setTimeout(done, 500)),
    attempts: 20,
  };
}

export async function enableStaffPassword({ release, setup = false }, runtime) {
  if (!/^[a-f0-9]{40}$/.test(release ?? "")) throw new Error(REFUSED);
  if (typeof setup !== "boolean") throw new Error(REFUSED);
  const rt = runtime ?? productionRuntime(release, setup);
  let lock,
    original,
    candidate,
    backup,
    pending,
    pendingBytes,
    pendingStat,
    activeStat,
    changed = false;
  const nonce = randomUUID();
  async function verify(enabled) {
    for (let attempt = 0; attempt < rt.attempts; attempt++) {
      try {
        lock.assertHeld();
        await rt.probe(enabled);
        return;
      } catch {
        /* bounded convergence */
      }
      if (attempt + 1 < rt.attempts) await rt.pause();
    }
    fail();
  }
  function assertCurrent(expected, stat) {
    const current = rt.readSecure(rt.envPath);
    if (
      !same(current.bytes, expected) ||
      (stat && (current.stat.ino !== stat.ino || current.stat.dev !== stat.dev))
    )
      fail();
  }
  try {
    lock = await rt.acquireLock();
    lock.assertHeld();
    rt.checkContext();
    original = rt.readSecure(rt.envPath);
    candidate = setup
      ? prepareStaffPasswordSetupEnable(original.bytes)
      : prepareStaffPasswordEnable(original.bytes);
    await rt.validate(candidate.raw);
    await rt.assertAliasReady(candidate.raw);
    await verify(candidate.alreadyEnabled);
    assertCurrent(original.bytes, original.stat);
    if (candidate.alreadyEnabled) return { status: "ALREADY_ENABLED" };
    backup = `${rt.envPath}.before-staff-password-${nonce}`;
    pending = `${rt.envPath}.staff-password-${nonce}.pending`;
    rt.writeSecure(backup, original.bytes, original.stat.gid);
    if (!same(rt.readSecure(backup).bytes, original.bytes)) fail();
    pendingBytes = candidate.bytes;
    pendingStat = rt.writeSecure(pending, pendingBytes, original.stat.gid);
    rt.syncDirectory(pending);
    const written = rt.readSecure(pending);
    if (!same(written.bytes, pendingBytes)) fail();
    await rt.validate(inspectStaffEnvironment(written.bytes).raw);
    lock.assertHeld();
    rt.checkContext();
    assertCurrent(original.bytes, original.stat);
    rt.rename(pending, rt.envPath);
    pending = undefined;
    changed = true;
    activeStat = rt.readSecure(rt.envPath).stat;
    rt.syncDirectory(rt.envPath);
    await rt.restart();
    await verify(true);
    assertCurrent(candidate.bytes, activeStat);
    return { status: "ENABLED", backup };
  } catch {
    if (changed && original && candidate) {
      try {
        lock.assertHeld();
        rt.checkContext(false); // A failed restart may leave MainPID=0.
        assertCurrent(candidate.bytes, activeStat);
        pending = `${rt.envPath}.staff-password-rollback-${nonce}.pending`;
        pendingBytes = original.bytes;
        pendingStat = rt.writeSecure(pending, pendingBytes, original.stat.gid);
        rt.syncDirectory(pending);
        if (!same(rt.readSecure(pending).bytes, original.bytes)) fail();
        lock.assertHeld();
        rt.checkContext(false);
        assertCurrent(candidate.bytes, activeStat);
        rt.rename(pending, rt.envPath);
        pending = undefined;
        rt.syncDirectory(rt.envPath);
        await rt.restart();
        await verify(false);
        assertCurrent(original.bytes);
      } catch {
        throw new Error(CRITICAL);
      }
      throw new Error(RESTORED);
    }
    throw new Error(REFUSED);
  } finally {
    if (pending) {
      try {
        // Do not remove a file replaced/modified by an outside writer.
        const current = rt.readSecure(pending);
        if (
          pendingStat &&
          current.stat.ino === pendingStat.ino &&
          current.stat.dev === pendingStat.dev &&
          same(current.bytes, pendingBytes)
        )
          rt.unlink(pending);
      } catch {
        /* preserve evidence and do not mask the original error */
      }
    }
    if (lock) await lock.release();
  }
}

export async function runCli(
  args,
  io = { log: console.log, error: console.error },
) {
  try {
    if (
      args.length !== 2 ||
      ![
        "--confirm-enable-staff-password",
        "--confirm-enable-staff-password-setup",
      ].includes(args[0]) ||
      !/^[a-f0-9]{40}$/.test(args[1] ?? "") ||
      process.getuid?.() !== 0
    )
      fail();
    const setup = args[0] === "--confirm-enable-staff-password-setup";
    const result = await enableStaffPassword({ release: args[1], setup });
    if (setup) {
      io.log(
        result.status === "ALREADY_ENABLED"
          ? "Staff first-password setup already enabled and verified; no configuration changed and no SMS sent."
          : "Staff first-password setup enabled and verified; only its gate changed, no credentials created and no SMS sent.",
      );
      return 0;
    }
    io.log(
      result.status === "ALREADY_ENABLED"
        ? "Staff password/SMS login already enabled and verified; no configuration changed and no SMS sent."
        : "Staff password/SMS login enabled and verified; WeChat, MFA, seven-day trust, daily budget and permissions unchanged; no SMS sent.",
    );
    return 0;
  } catch (error) {
    // Schema/provider/DB exceptions may contain secrets; only fixed errors escape.
    io.error(
      [REFUSED, RESTORED, CRITICAL].includes(error?.message)
        ? error.message
        : REFUSED,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runCli(process.argv.slice(2));

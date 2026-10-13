// Owner-confirmed login-only device trust. Never enables SMS or changes users.
import {
  chownSync,
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

const [confirmation, release] = process.argv.slice(2);
const envPath = "/etc/zhongyuan-daojia/api.env";
const current = "/opt/zhongyuan-daojia/current";
const apiBase = "http://127.0.0.1:3220/v1";
const unit = "zhongyuan-daojia-api.service";
let original;
let changed = false;
let originalGroup;

async function configuration(path) {
  const response = await fetch(`${apiBase}${path}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw Error("Configuration probe failed");
  return (await response.json()).data;
}
async function verify(enabled) {
  const [trust, password, browser] = await Promise.all([
    configuration("/auth/trusted-devices/config"),
    configuration("/auth/staff-password/config"),
    configuration("/auth/browser-login/config"),
  ]);
  if (
    trust.enabled !== enabled ||
    trust.maxDays !== 7 ||
    password.enabled !== false ||
    password.smsEnabled !== false ||
    browser.enabled !== true ||
    browser.provider !== "wechat"
  )
    throw Error("Login feature state mismatch");
  const health = await fetch(`${apiBase}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  const protectedRoute = await fetch(`${apiBase}/auth/trusted-devices`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok || protectedRoute.status !== 401)
    throw Error("Authentication health mismatch");
}
async function waitForState(enabled) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await verify(enabled);
      return;
    } catch {
      /* bounded restart convergence */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw Error("Service did not converge");
}
try {
  if (
    confirmation !== "--confirm-seven-day-login-trust" ||
    !/^[0-9a-f]{40}$/.test(release ?? "") ||
    process.getuid?.() !== 0
  )
    throw Error("Explicit owner-confirmed release required");
  if (
    realpathSync(current) !== `/opt/zhongyuan-daojia/releases/${release}` ||
    readFileSync(`${current}/DEPLOY_COMMIT`, "utf8").trim() !== release
  )
    throw Error("Unexpected API release");
  const stat = lstatSync(envPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o077) !== 0
  )
    throw Error("Unsafe configuration file");
  originalGroup = stat.gid;
  original = readFileSync(envPath, "utf8");
  const lines = original.split(/\r?\n/);
  function value(key) {
    const matches = lines.filter((line) => line.startsWith(`${key}=`));
    if (matches.length > 1) throw Error("Duplicate feature configuration");
    const raw = matches[0]?.slice(key.length + 1).trim() ?? "";
    return /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  if (
    value("NODE_ENV") !== "production" ||
    value("AUTH_PROVIDER") !== "wechat" ||
    value("STAFF_BROWSER_LOGIN_ENABLED") !== "true" ||
    !["", "false"].includes(value("STAFF_PASSWORD_LOGIN_ENABLED"))
  )
    throw Error("Existing authentication gates must remain unchanged");
  const previous = value("STAFF_TRUSTED_DEVICE_ENABLED");
  if (!["", "false", "true"].includes(previous))
    throw Error("Unexpected device trust value");
  if (previous === "true") {
    await verify(true);
    console.log(
      "Seven-day login trust already enabled; SMS login remains disabled.",
    );
  } else {
    await verify(false);
    const nonce = `${Date.now()}-${release}`;
    const backup = `${envPath}.before-staff-trust-${nonce}`;
    const candidate = `${envPath}.staff-trust-${nonce}.pending`;
    copyFileSync(envPath, backup, constants.COPYFILE_EXCL);
    const next = lines.map((line) =>
      line.startsWith("STAFF_TRUSTED_DEVICE_ENABLED=")
        ? "STAFF_TRUSTED_DEVICE_ENABLED=true"
        : line,
    );
    if (!lines.some((line) => line.startsWith("STAFF_TRUSTED_DEVICE_ENABLED=")))
      next.push("STAFF_TRUSTED_DEVICE_ENABLED=true");
    writeFileSync(candidate, next.join("\n"), { mode: 0o600, flag: "wx" });
    chownSync(candidate, 0, originalGroup);
    renameSync(candidate, envPath);
    changed = true;
    execFileSync("systemctl", ["restart", unit], { stdio: "ignore" });
    await waitForState(true);
    console.log(
      "Seven-day login-only device trust enabled and verified; SMS login remains disabled. User permissions and MFA credentials unchanged.",
    );
  }
} catch {
  if (changed && original !== undefined) {
    try {
      const rollback = `${envPath}.staff-trust-rollback-${Date.now()}.pending`;
      writeFileSync(rollback, original, { mode: 0o600, flag: "wx" });
      chownSync(rollback, 0, originalGroup);
      renameSync(rollback, envPath);
      execFileSync("systemctl", ["restart", unit], { stdio: "ignore" });
      await waitForState(false);
      console.error(
        "Device trust activation failed; original configuration restored and verified.",
      );
    } catch {
      console.error(
        "CRITICAL: device trust rollback could not be verified; inspect service state.",
      );
    }
  } else
    console.error("Device trust activation refused; configuration unchanged.");
  process.exitCode = 1;
}

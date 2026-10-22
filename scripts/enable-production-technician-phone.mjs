// Explicit one-gate activation. Probes never contain phone numbers or login proofs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enableStaffPassword,
  inspectStaffEnvironment,
  productionRuntime,
} from "./enable-production-staff-password.mjs";

const BASE = "/opt/zhongyuan-daojia";
const LOGIN_GATE = "TECHNICIAN_PHONE_LOGIN_ENABLED";
const WORKBENCH_GATE = "TECHNICIAN_PHONE_WORKBENCH_ENABLED";
const MIGRATION = "20261022010000_technician_phone_login";
const REFUSED =
  "Technician phone activation refused; active configuration unchanged";
const RESTORED =
  "Technician phone activation failed; original configuration restored and verified";
const CRITICAL =
  "CRITICAL: technician phone activation rollback requires attention";
const fail = () => {
  throw Error("Technician phone activation precondition failed");
};
const selectedGate = (mode) => {
  if (mode === "login") return LOGIN_GATE;
  if (mode === "workbench") return WORKBENCH_GATE;
  fail();
};

export function inspectTechnicianPhoneEnvironment(bytes) {
  const parsed = inspectStaffEnvironment(bytes);
  const { raw } = parsed;
  if (
    raw.STAFF_PASSWORD_LOGIN_ENABLED !== "true" ||
    raw.PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT !== "20" ||
    ![undefined, "false", "true"].includes(raw[LOGIN_GATE]) ||
    ![undefined, "false", "true"].includes(raw[WORKBENCH_GATE]) ||
    (raw[WORKBENCH_GATE] === "true" && raw[LOGIN_GATE] !== "true")
  )
    fail();
  return parsed;
}

/** Only the two named feature gates are supported; never accepts arbitrary keys. */
export function prepareTechnicianPhoneEnable(original, mode) {
  const gate = selectedGate(mode);
  const before = inspectTechnicianPhoneEnvironment(original);
  if (mode === "workbench" && before.raw[LOGIN_GATE] !== "true") fail();
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
  const after = inspectTechnicianPhoneEnvironment(bytes).raw;
  if (after[gate] !== "true") fail();
  for (const key of new Set([
    ...Object.keys(before.raw),
    ...Object.keys(after),
  ]))
    if (key !== gate && before.raw[key] !== after[key]) fail();
  return { bytes, raw: after, alreadyEnabled: false };
}

// Fixed schema metadata only, never technician, user, phone, challenge or session rows.
export const TECHNICIAN_PHONE_METADATA_QUERY = `SELECT
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public'
    AND table_name='TechnicianPhoneLoginChallenge') AS "tableReady",
  (SELECT count(*)=13 AND bool_and(column_name IN
    ('id','phoneHash','phoneEncrypted','requestIpHash','secretHash','codeHash','status','attempts','expiresAt','createdAt','consumedAt','providerRequestId','providerBizId'))
    FROM information_schema.columns WHERE table_schema='public' AND table_name='TechnicianPhoneLoginChallenge') AS "columnsReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='TechnicianPhoneLoginChallenge' AND c.conname='TechnicianPhoneLoginChallenge_pkey'
    AND c.contype='p' AND c.convalidated) AS "primaryKeyReady",
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='TechnicianPhoneLoginChallenge' AND c.contype='f') AS "noForeignKeysReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='TechnicianPhoneLoginChallenge' AND c.conname='TechnicianPhoneLoginChallenge_attempts_check'
    AND c.contype='c' AND c.convalidated
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%attempts%>= 0%attempts%<= 5%') AS "attemptsCheckReady",
  (SELECT count(*)=2 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='TechnicianPhoneLoginChallenge' AND i.indisvalid
    AND x.relname IN ('TechnicianPhoneLoginChallenge_phoneHash_createdAt_idx','TechnicianPhoneLoginChallenge_expiresAt_idx')) AS "indexesReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='Session' AND c.conname='Session_technician_phone_scope_check'
    AND c.contype='c' AND c.convalidated
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%TECHNICIAN_PHONE%technician-sms%TECHNICIAN_PHONE%technician-sms%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%customerPhoneHash%IS NOT NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%wechatIdentityId%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffVerifiedUntil%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffVerificationMethod%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffPasswordVersion%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%trustedDeviceId%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%mfaVerifiedUntil%IS NULL%') AS "sessionScopeReady",
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    AND t.relname='Session' AND c.conname='Session_auth_provenance_check'
    AND c.contype='c' AND c.convalidated
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%authChannel%LEGACY%authProvider%unknown%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%authChannel%WECHAT_MINIAPP%ADMIN_BROWSER%authProvider%wechat%mock%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%authChannel%ADMIN_BROWSER%authProvider%staff-password%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%authChannel%CUSTOMER_SMS%authProvider%customer-sms%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%authChannel%TECHNICIAN_PHONE%authProvider%technician-sms%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%customerPhoneHash%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%customerPhoneHash%IS NOT NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%customerPhoneHash%~%''^[0-9a-f]{64}$''%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%wechatIdentityId%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%mfaVerifiedUntil%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffVerifiedUntil%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffVerificationMethod%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%staffPasswordVersion%IS NULL%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%trustedDeviceId%IS NULL%') AS "sessionProvenanceReady",
  EXISTS (SELECT 1 FROM public."_prisma_migrations" WHERE migration_name='${MIGRATION}'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS "migrationReady",
  NOT EXISTS (SELECT 1 FROM public."_prisma_migrations" WHERE finished_at IS NULL
    AND rolled_back_at IS NULL) AS "noPendingMigrationsReady"`;

export function assertTechnicianPhoneMetadata(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    [
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
    ].some((key) => rows[0]?.[key] !== true)
  )
    fail();
}

export function assertTechnicianPhoneCapabilities(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.data?.enabled !== expected.enabled ||
    value.data?.workbenchEnabled !== expected.workbenchEnabled
  )
    fail();
}

function technicianProductionRuntime(release, mode) {
  selectedGate(mode);
  const rt = productionRuntime(release, false);
  const expected = `${BASE}/releases/${release}`;
  let originalRaw, invariantConfig;
  const get = (path) =>
    fetch(`http://127.0.0.1:3220/v1${path}`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
  return {
    ...rt,
    prepareCandidate(bytes) {
      originalRaw = inspectTechnicianPhoneEnvironment(bytes).raw;
      return prepareTechnicianPhoneEnable(bytes, mode);
    },
    async assertAliasReady(raw) {
      await rt.assertAliasReady(raw);
      const service = readFileSync(
        `${expected}/apps/api/dist/auth/technician-phone-auth.service.js`,
        "utf8",
      );
      const controller = readFileSync(
        `${expected}/apps/api/dist/auth/technician-phone-auth.controller.js`,
        "utf8",
      );
      const guard = readFileSync(
        `${expected}/apps/api/dist/auth/session-auth.guard.js`,
        "utf8",
      );
      for (const marker of [
        "TechnicianPhoneAuthService",
        LOGIN_GATE,
        WORKBENCH_GATE,
        "TECHNICIAN_PHONE",
        "technician-sms",
      ])
        if (!service.includes(marker)) fail();
      if (
        !controller.includes("technician-phone") ||
        !guard.includes("TECHNICIAN_PHONE")
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
            await tx.$executeRawUnsafe(
              "SET LOCAL statement_timeout = '3000ms'",
            );
            return tx.$queryRawUnsafe(TECHNICIAN_PHONE_METADATA_QUERY);
          },
          { maxWait: 3000, timeout: 5000 },
        );
        assertTechnicianPhoneMetadata(rows);
      } finally {
        await prisma.$disconnect();
      }
    },
    async probe(enabled) {
      // Existing live staff, customer and trust checks must remain true. The
      // technician gate is separate and cannot stand in for customer purpose.
      await rt.probe(true);
      const [caps, staff, browser, trust, mfa] = await Promise.all([
        get("/auth/technician-phone/capabilities"),
        get("/auth/staff-password/config"),
        get("/auth/browser-login/config"),
        get("/auth/trusted-devices/config"),
        get("/auth/mfa"),
      ]);
      if (
        [caps, staff, browser, trust].some((r) => r.status !== 200) ||
        mfa.status !== 401
      )
        fail();
      const baseline = JSON.stringify(
        await Promise.all([staff.json(), browser.json(), trust.json()]),
      );
      if (invariantConfig === undefined) invariantConfig = baseline;
      else if (invariantConfig !== baseline) fail();
      if (!originalRaw) fail();
      assertTechnicianPhoneCapabilities(await caps.json(), {
        enabled:
          mode === "login" ? enabled : originalRaw[LOGIN_GATE] === "true",
        workbenchEnabled:
          mode === "workbench"
            ? enabled
            : originalRaw[WORKBENCH_GATE] === "true",
      });
      for (const action of ["request", "confirm"]) {
        // Empty invalid input stops at controller schema validation. Never
        // include a destination, code, secret, consent or account identifier.
        const invalid = await fetch(
          `http://127.0.0.1:3220/v1/auth/technician-phone/sms/${action}`,
          {
            method: "POST",
            body: "{}",
            signal: AbortSignal.timeout(1500),
            redirect: "error",
            headers: { "Content-Type": "application/json" },
          },
        );
        if (invalid.status !== 400) fail();
      }
    },
  };
}

export async function enableTechnicianPhone({ release, mode }, runtime) {
  try {
    if (!/^[a-f0-9]{40}$/.test(release ?? "")) fail();
    selectedGate(mode);
    const rt = runtime ?? technicianProductionRuntime(release, mode);
    // Even injected transaction adapters cannot substitute a different gate.
    const wrapped = {
      ...rt,
      prepareCandidate: (bytes) => {
        const result = prepareTechnicianPhoneEnable(bytes, mode);
        if (rt.prepareCandidate) {
          const delegated = rt.prepareCandidate(bytes);
          if (
            !Buffer.isBuffer(delegated?.bytes) ||
            !delegated.bytes.equals(result.bytes)
          )
            fail();
        }
        return result;
      },
    };
    return await enableStaffPassword({ release }, wrapped);
  } catch (error) {
    if (
      error?.message ===
      "CRITICAL: staff password activation rollback requires attention"
    )
      throw Error(CRITICAL);
    if (
      error?.message ===
      "Staff password activation failed; original configuration restored and verified"
    )
      throw Error(RESTORED);
    throw Error(REFUSED);
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
        "--confirm-enable-technician-phone-login",
        "--confirm-enable-technician-phone-workbench",
      ].includes(args[0]) ||
      !/^[a-f0-9]{40}$/.test(args[1] ?? "") ||
      process.getuid?.() !== 0
    )
      fail();
    const mode =
      args[0] === "--confirm-enable-technician-phone-login"
        ? "login"
        : "workbench";
    const result = await enableTechnicianPhone({ release: args[1], mode });
    io.log(
      result.status === "ALREADY_ENABLED"
        ? "Technician phone feature already enabled and verified; no configuration changed and no SMS sent."
        : "Technician phone feature enabled and verified; only its selected gate changed, all other settings preserved and no SMS sent.",
    );
    return 0;
  } catch (error) {
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

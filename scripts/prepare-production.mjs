// Root-only, one-shot staging. Does not start services, seed users, or enable payment.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import {
  randomBytes,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const source = "/opt/zhongyuan-daojia-acceptance/current";
const config = "/etc/zhongyuan-daojia";
const pending = `${config}/api.env.pending`;
const base = "/opt/zhongyuan-daojia";
if (
  process.getuid?.() !== 0 ||
  process.env.CONFIRM_PREPARE_PRODUCTION !== "mtsc.top"
)
  throw Error("Explicit production preparation scope required");
if (
  readFileSync("/opt/zhongyuan-daojia-acceptance/OWNER", "utf8").trim() !==
    "zhongyuan-daojia-private-acceptance" ||
  !realpathSync(source).startsWith(
    "/opt/zhongyuan-daojia-acceptance/releases/",
  ) ||
  existsSync(config) ||
  existsSync(base)
)
  throw Error(
    "Unexpected or existing production scope; inspect before retrying",
  );
const sql = (text) =>
  execFileSync(
    "runuser",
    [
      "-u",
      "postgres",
      "--",
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
    ],
    { input: text, encoding: "utf8" },
  );
if (
  sql("SELECT count(*) FROM pg_roles WHERE rolname='zydj_app';").trim() !==
    "0" ||
  sql(
    "SELECT count(*) FROM pg_database WHERE datname='zhongyuan_daojia';",
  ).trim() !== "0"
)
  throw Error(
    "Production database or role already exists; no rotation or overwrite allowed",
  );
const { validateEnv } = await import(
  pathToFileURL(`${source}/apps/api/dist/config/env.js`).href
);
const raw = {};
for (const line of readFileSync(
  "/opt/jingxiang-platform/shared/legacy-api.env",
  "utf8",
).split(/\r?\n/)) {
  const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (match) raw[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
}
const legacy = validateEnv({ ...raw, NODE_ENV: "test" });
const certificates = "/opt/jingxiang-platform/shared/certs";
const privateKey = createPrivateKey(
  readFileSync(`${certificates}/apiclient_key.pem`),
);
const publicKey = createPublicKey(
  readFileSync(`${certificates}/wechatpay_public_key.pem`),
);
if (
  privateKey.asymmetricKeyType !== "rsa" ||
  publicKey.asymmetricKeyType !== "rsa"
)
  throw Error("Expected verified RSA payment material");
const certificate = new X509Certificate(
  readFileSync(`${certificates}/apiclient_cert.pem`),
);
if (
  !certificate.checkPrivateKey(privateKey) ||
  certificate.serialNumber.replace(/^0+/, "").toUpperCase() !==
    legacy.WECHAT_PAY_MERCHANT_SERIAL_NO.replace(/^0+/, "").toUpperCase() ||
  Date.parse(certificate.validTo) <= Date.now()
)
  throw Error("Merchant certificate verification failed");
const password = randomBytes(32).toString("hex");
const env = {
  NODE_ENV: "production",
  BRAND_NAME: "中原到家",
  API_HOST: "127.0.0.1",
  API_PORT: "3220",
  DATABASE_URL: `postgresql://zydj_app:${password}@127.0.0.1:5432/zhongyuan_daojia?schema=public&connection_limit=10`,
  CORS_ORIGINS: "https://admin.mtsc.top,https://mtsc.top",
  AUTH_PROVIDER: "wechat",
  STAFF_MFA_REQUIRED: "true",
  STAFF_BROWSER_LOGIN_ENABLED: "true",
  AUTH_SESSION_PEPPER: randomBytes(32).toString("hex"),
  DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
  WECHAT_MINIAPP_APP_ID: legacy.WECHAT_MINIAPP_APP_ID,
  WECHAT_MINIAPP_SECRET: legacy.WECHAT_MINIAPP_SECRET,
  WECHAT_OFFICIAL_ACCOUNT_ID: "gh_a4b5f9d63539",
  PAYMENT_PROVIDER: "wechat",
  WECHAT_MCH_ID: legacy.WECHAT_MCH_ID,
  WECHAT_PAY_API_V3_KEY: legacy.WECHAT_PAY_API_V3_KEY,
  WECHAT_PAY_MERCHANT_SERIAL_NO: legacy.WECHAT_PAY_MERCHANT_SERIAL_NO,
  WECHAT_PAY_PRIVATE_KEY_PATH: `${config}/certs/apiclient_key.pem`,
  WECHAT_PAY_MERCHANT_CERT_PATH: `${config}/certs/apiclient_cert.pem`,
  WECHAT_PAY_PUBLIC_KEY_ID: legacy.WECHAT_PAY_PUBLIC_KEY_ID,
  WECHAT_PAY_PUBLIC_KEY_PATH: `${config}/certs/wechatpay_public_key.pem`,
  WECHAT_PAY_NOTIFY_URL: "https://api.mtsc.top/v1/payments/wechat/notify",
  WECHAT_PAY_REFUND_NOTIFY_URL:
    "https://api.mtsc.top/v1/payments/wechat/refund-notify",
  WECHAT_PAY_PREPAY_ENABLED: "false",
  WECHAT_PAY_REFUND_ENABLED: "false",
  WECHAT_PAY_RECOVERY_ENABLED: "false",
  SMS_PROVIDER: "mock",
  SMS_SEND_ENABLED: "false",
  SAFETY_NOTIFICATION_DISPATCH_ENABLED: "false",
  SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "false",
  MAP_PROVIDER: "mock",
  MAP_GEOCODING_ENABLED: "false",
  SERVICE_AREA_ADCODE_ALLOWLIST:
    "410102,410103,410104,410105,410106,410108,410122,410171,410172,410173,410181,410182,410183,410184,410185",
  SAFETY_HOTLINE: "",
  SAFETY_DUTY_CONFIRMED: "false",
};
if (env.WECHAT_MINIAPP_APP_ID !== "wxab76ea213eb6d01a")
  throw Error("Miniapp identity changed");
const expectedGate =
  "生产配置未通过安全门禁: SMS_PROVIDER, MAP_PROVIDER, SAFETY_HOTLINE";
let gate;
try {
  validateEnv(env);
} catch (error) {
  gate = error.message;
}
if (gate !== expectedGate)
  throw Error(
    "Unexpected production preflight result; no database changes made",
  );
for (const [key, value] of Object.entries(env))
  if (/[\r\n']/.test(value))
    throw Error(`Unsafe controlled env encoding: ${key}`);
mkdirSync(config, { mode: 0o700 });
mkdirSync(`${config}/certs`, { mode: 0o700 });
mkdirSync(base, { mode: 0o750 });
writeFileSync(`${base}/OWNER`, "zhongyuan-daojia-production-staging\n", {
  mode: 0o600,
  flag: "wx",
});
for (const file of [
  "apiclient_key.pem",
  "apiclient_cert.pem",
  "wechatpay_public_key.pem",
]) {
  copyFileSync(`${certificates}/${file}`, `${config}/certs/${file}`);
  chmodSync(`${config}/certs/${file}`, 0o600);
}
writeFileSync(
  pending,
  Object.entries(env)
    .map(([k, v]) => `${k}='${v}'`)
    .join("\n") + "\n",
  { mode: 0o600, flag: "wx" },
);
mkdirSync(`${base}/backups`, { mode: 0o700 });
copyFileSync(pending, `${base}/backups/api.env.initial`);
chmodSync(`${base}/backups/api.env.initial`, 0o600);
// Password goes through stdin, never argv, shell history, or printed diagnostics.
sql(readFileSync(`${source}/infra/database-init.sql`, "utf8"));
sql(`ALTER ROLE zydj_app PASSWORD '${password}';`);
const tooling =
  "/opt/zhongyuan-daojia-acceptance/tooling/node_modules/.bin/pnpm";
execFileSync(
  tooling,
  ["--filter", "@zydj/api", "exec", "prisma", "migrate", "deploy"],
  {
    cwd: source,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: "inherit",
  },
);
execFileSync(
  tooling,
  ["--filter", "@zydj/api", "exec", "prisma", "migrate", "status"],
  {
    cwd: source,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: "inherit",
  },
);
console.log(
  JSON.stringify({
    database: "zhongyuan_daojia",
    configuration: pending,
    servicesStarted: false,
    realPaymentsEnabled: false,
    pendingGateFields: ["SMS_PROVIDER", "MAP_PROVIDER", "SAFETY_HOTLINE"],
  }),
);

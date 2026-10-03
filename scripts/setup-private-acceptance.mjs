// Run only by the root-owned private deployment script. Never reuse an existing business DB or credentials.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
const base = "/opt/zhongyuan-daojia-acceptance";
const configDir = "/etc/zhongyuan-daojia-acceptance";
const envPath = `${configDir}/api.env`;
if (process.getuid?.() !== 0 || process.cwd() !== base)
  throw Error("Private deployment scope invalid");
mkdirSync(configDir, { recursive: true, mode: 0o750 });
if (!existsSync(envPath)) {
  const password = randomBytes(32).toString("hex");
  const env = {
    NODE_ENV: "test",
    BRAND_NAME: "中原到家（私有验收）",
    API_HOST: "127.0.0.1",
    API_PORT: "3210",
    DATABASE_URL: `postgresql://zydj_acceptance:${password}@127.0.0.1:5432/zydj_acceptance?schema=public&connection_limit=10`,
    AUTH_PROVIDER: "mock",
    PAYMENT_PROVIDER: "mock",
    SMS_PROVIDER: "mock",
    MAP_PROVIDER: "mock",
    AUTH_SESSION_PEPPER: randomBytes(32).toString("hex"),
    DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    WECHAT_PAY_PREPAY_ENABLED: "false",
    WECHAT_PAY_REFUND_ENABLED: "false",
    WECHAT_PAY_RECOVERY_ENABLED: "false",
    CORS_ORIGINS: "http://127.0.0.1:5312,http://127.0.0.1:5313",
  };
  writeFileSync(
    envPath,
    Object.entries(env)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([A-Z_][A-Z0-9_]*)='([^']*)'$/.exec(line);
      if (!match) throw Error("Invalid controlled env file");
      return [match[1], match[2]];
    }),
);
if (
  env.NODE_ENV !== "test" ||
  env.AUTH_PROVIDER !== "mock" ||
  env.PAYMENT_PROVIDER !== "mock" ||
  env.API_HOST !== "127.0.0.1" ||
  [
    "WECHAT_PAY_PREPAY_ENABLED",
    "WECHAT_PAY_REFUND_ENABLED",
    "WECHAT_PAY_RECOVERY_ENABLED",
  ].some((k) => env[k] !== "false")
)
  throw Error("Private gate changed; refusing deployment");
const target = new URL(env.DATABASE_URL);
if (
  target.hostname !== "127.0.0.1" ||
  target.pathname !== "/zydj_acceptance" ||
  target.username !== "zydj_acceptance"
)
  throw Error("Wrong private database");
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
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
const role = sql(
  "SELECT rolname FROM pg_roles WHERE rolname='zydj_acceptance';",
);
if (!role)
  sql(
    `CREATE ROLE zydj_acceptance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20 PASSWORD '${target.password}';`,
  );
if (
  sql(
    "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='zydj_acceptance';",
  ) !== "f"
)
  throw Error("Acceptance role must be restricted");
const owner = sql(
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='zydj_acceptance';",
);
if (!owner) sql("CREATE DATABASE zydj_acceptance OWNER zydj_acceptance;");
else if (owner !== "zydj_acceptance")
  throw Error("Existing DB has another owner; refusing");
execFileSync(
  "runuser",
  [
    "-u",
    "postgres",
    "--",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    "zydj_acceptance",
    "-c",
    "CREATE EXTENSION IF NOT EXISTS btree_gist;",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
execFileSync("chown", ["root:zydj-acceptance", configDir, envPath]);
chmodSync(envPath, 0o640);
const node = `${base}/runtime/node-v24.19.0-linux-x64/bin/node`;
for (const name of ["api", "admin", "h5"]) {
  const api = name === "api";
  const port = name === "admin" ? 3212 : 3213;
  const service = `[Unit]\nDescription=Zhongyuan Daojia PRIVATE acceptance ${name}\nAfter=network-online.target postgresql.service\nWants=network-online.target\n[Service]\nType=simple\nUser=zydj-acceptance\nGroup=zydj-acceptance\nWorkingDirectory=${base}/current/${api ? "apps/api" : ""}\n${api ? `EnvironmentFile=${envPath}` : `Environment=PREVIEW_ROOT=${base}/current/apps/${name === "admin" ? "admin-web" : "workbench-h5"}/dist\nEnvironment=PREVIEW_PORT=${port}\nEnvironment=PREVIEW_API_PORT=3210`}\nExecStart=${node} ${api ? "dist/main.js" : `${base}/current/scripts/serve-private-preview.mjs`}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nUMask=0077\nMemoryMax=${api ? "512M" : "128M"}\nCPUQuota=${api ? "50%" : "25%"}\n[Install]\nWantedBy=multi-user.target\n`;
  const path = `/etc/systemd/system/zhongyuan-daojia-acceptance-${name}.service`;
  if (
    existsSync(path) &&
    !readFileSync(path, "utf8").includes(`WorkingDirectory=${base}/current`)
  )
    throw Error("Foreign service; refusing overwrite");
  writeFileSync(path, service, { mode: 0o644 });
}
console.log(
  "Private configuration prepared; secrets not printed; real channel gates closed",
);

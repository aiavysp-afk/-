import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "wxab76ea213eb6d01a";
const MAX_RESPONSE_BYTES = 64 * 1024;
const TEMPLATE_FILES = Object.freeze([
  "app.js",
  "app.json",
  "app.wxss",
  "sitemap.json",
  "pages/contact/index.js",
  "pages/contact/index.json",
  "pages/contact/index.wxml",
  "pages/contact/index.wxss",
]);
const HELPER_PATH = "apps/miniapp/utils/customer-service.js";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

class SafePackageError extends Error {}

function fail(message) {
  throw new SafePackageError(message);
}

export function parseArguments(args) {
  if (!args.length) return { port: 5310 };
  if (args.length !== 2 || args[0] !== "--port")
    fail("Usage: node scripts/package-contact-acceptance.mjs [--port 5310]");
  return { port: validatePort(args[1]) };
}

function validatePort(value) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text)) fail("Invalid loopback port");
  const port = Number(text);
  if (port > 65535) fail("Invalid loopback port");
  return port;
}

export function validatePublicConfigUrl(value) {
  const literal = String(value).match(
    /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1\/config\/public$/,
  );
  if (!literal)
    fail("Only an explicit loopback public-config endpoint is permitted");
  validatePort(literal[1]);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Invalid loopback public-config URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/v1/config/public" ||
    url.search ||
    url.hash
  )
    fail("Only an explicit loopback public-config endpoint is permitted");
  return url.href;
}

async function readBoundedJson(response) {
  if (!response.ok || response.redirected)
    fail("Loopback public configuration was not returned directly");
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    fail("Loopback public configuration must be JSON");
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    fail("Loopback public configuration exceeds the response limit");
  }
  if (!response.body) fail("Loopback public configuration was empty");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("Loopback public configuration exceeds the response limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    fail("Loopback public configuration contains invalid JSON");
  }
}

export async function fetchPublicContacts({
  port = 5310,
  fetchImpl = fetch,
  schema,
} = {}) {
  const url = validatePublicConfigUrl(
    `http://127.0.0.1:${validatePort(port)}/v1/config/public`,
  );
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    fail("Cannot read the loopback public configuration");
  }
  if (response.url && response.url !== url)
    fail("Loopback public configuration response has an unexpected origin");
  const envelope = await readBoundedJson(response);
  const parsed = schema.safeParse(envelope?.data);
  if (!parsed.success)
    fail("Public configuration failed @zydj/contracts validation");
  const { customerService, emergencyContact, miniappAppId } = parsed.data;
  if (
    miniappAppId !== APP_ID ||
    customerService?.provider !== "wecom" ||
    customerService.available !== true ||
    !customerService.corpId ||
    !customerService.url ||
    emergencyContact?.configured !== true ||
    !/^1[3-9]\d{9}$/.test(emergencyContact.phone)
  )
    fail(
      "Confirmed customer service and a valid configured merchant duty phone are required",
    );
  // Explicitly selected public fields only. Never persist the full API response.
  return {
    customerService: {
      provider: "wecom",
      available: true,
      corpId: customerService.corpId,
      url: customerService.url,
    },
    emergencyContact: { configured: true, phone: emergencyContact.phone },
  };
}

export function validateContactHelper(source) {
  if (
    /\b(?:fetch|XMLHttpRequest|WebSocket|requestPayment|login|request|eval|Function)\b/.test(
      source,
    ) ||
    /\b(?:require|import)\s*\(/.test(source) ||
    /\bhost\s*\[/.test(source) ||
    /\bwx\s*(?:\.|\[)/.test(source)
  )
    fail(
      "Contact helper must not contain request, login, payment, or dynamic code capabilities",
    );
  const allowed = new Set([
    "showToast",
    "openCustomerServiceChat",
    "makePhoneCall",
  ]);
  const members = [...source.matchAll(/\bhost\s*\.\s*([A-Za-z_$][\w$]*)/g)].map(
    (row) => row[1],
  );
  if (members.some((member) => !allowed.has(member)))
    fail("Contact helper contains an unapproved native API");
  for (const member of allowed)
    if (!members.includes(member))
      fail("Compiled contact helper is incomplete");
  if (
    !source.includes(
      "exports.openWecomCustomerService = openWecomCustomerService;",
    ) ||
    !source.includes("exports.callEmergencyDuty = callEmergencyDuty;")
  )
    fail("Expected compiled customer-service helper exports are missing");
  return source;
}

function assertInside(root, target) {
  const part = relative(root, target);
  if (!part || part.startsWith(`..${sep}`) || part === ".." || isAbsolute(part))
    fail("Package path escaped the intended repository directory");
}

async function assertNoSymlinkParts(root, target) {
  assertInside(root, target);
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = resolve(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        fail("Package paths may not traverse symbolic links");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function currentCommit(root) {
  let commit;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("An existing repository commit is required");
  }
  if (!/^[0-9a-f]{40}$/.test(commit))
    fail("Expected the current 40-character commit");
  return commit;
}

function assertCommittedInput(root, commit, repoPath, source) {
  let committed;
  try {
    committed = execFileSync(
      "git",
      ["-C", root, "show", `${commit}:${repoPath}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    fail("Package inputs must be tracked at the current commit");
  }
  if (committed.replace(/\r\n/g, "\n") !== source.replace(/\r\n/g, "\n"))
    fail(
      "Package inputs differ from the current commit; commit reviewed changes first",
    );
}

export async function packageContactAcceptance({
  repoRoot = REPO_ROOT,
  port = 5310,
  fetchImpl = fetch,
  schema,
} = {}) {
  const root = await realpath(repoRoot);
  const commit = currentCommit(root);
  const base = resolve(root, ".codex-runtime/miniapp-contact-acceptance");
  const destination = resolve(base, commit);
  await assertNoSymlinkParts(root, destination);
  try {
    await lstat(destination);
    fail(
      "This commit's acceptance package already exists; refusing to overwrite",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const files = new Map();
  for (const name of TEMPLATE_FILES) {
    const repoPath = `assets/contact-acceptance/${name}`;
    const sourcePath = resolve(root, repoPath);
    await assertNoSymlinkParts(root, sourcePath);
    const source = (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n");
    assertCommittedInput(root, commit, repoPath, source);
    files.set(name, source);
  }
  const helperPath = resolve(root, HELPER_PATH);
  await assertNoSymlinkParts(root, helperPath);
  const helper = (await readFile(helperPath, "utf8")).replace(/\r\n/g, "\n");
  assertCommittedInput(root, commit, HELPER_PATH, helper);
  files.set("utils/customer-service.js", validateContactHelper(helper));
  if (!schema) {
    // This is the compiled PublicConfigSchema exported by the @zydj/contracts workspace.
    try {
      ({ PublicConfigSchema: schema } = await import(
        pathToFileURL(resolve(root, "packages/contracts/dist/index.js")).href
      ));
    } catch {
      fail("Build @zydj/contracts before packaging contact acceptance");
    }
  }
  const contacts = await fetchPublicContacts({ port, fetchImpl, schema });
  files.set(
    "contacts.public.js",
    `"use strict";\nmodule.exports = ${JSON.stringify(contacts, null, 2)};\n`,
  );
  files.set(
    "project.config.json",
    `${JSON.stringify(
      {
        description: "中原到家联系渠道专项验收，非商城经营版",
        appid: APP_ID,
        projectname: "zhongyuan-daojia-contact-acceptance",
        compileType: "miniprogram",
        miniprogramRoot: "./",
        libVersion: "3.8.12",
        setting: {
          urlCheck: true,
          es6: true,
          enhance: true,
          minified: true,
          uploadWithSourceMap: false,
        },
        packOptions: { ignore: [], include: [] },
      },
      null,
      2,
    )}\n`,
  );
  const manifest = {
    format: "zydj-contact-acceptance/v1",
    commit,
    purpose: "CONTACT_CHANNELS_ONLY_NOT_A_COMMERCE_RELEASE",
    capabilities: ["openCustomerServiceChat", "makePhoneCall", "showToast"],
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, contents]) => ({
        path,
        bytes: Buffer.byteLength(contents),
        sha256: sha256(contents),
      })),
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  files.set("ACCEPTANCE_MANIFEST.json", manifestSource);
  await mkdir(base, { recursive: true });
  // Atomic reservation: concurrent or repeated invocation cannot reuse this directory.
  await mkdir(destination);
  for (const [name, content] of files) {
    const target = resolve(destination, name);
    assertInside(destination, target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
  return {
    path: destination,
    commit,
    manifestSha256: sha256(manifestSource),
    files: [...files.keys()].sort(),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const receipt = await packageContactAcceptance(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    // Errors deliberately exclude response bodies, contact values, and native provider details.
    const message =
      error instanceof SafePackageError
        ? error.message
        : "Unexpected packaging failure; no receipt was issued";
    process.stderr.write(`Contact acceptance packaging failed: ${message}\n`);
    process.exitCode = 1;
  }
}

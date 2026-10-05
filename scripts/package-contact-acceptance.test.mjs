import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PublicConfigSchema } from "../packages/contracts/dist/index.js";
import {
  fetchPublicContacts,
  packageContactAcceptance,
  parseArguments,
  validateContactHelper,
  validatePublicConfigUrl,
} from "./package-contact-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateFiles = [
  "app.js",
  "app.json",
  "app.wxss",
  "sitemap.json",
  "pages/contact/index.js",
  "pages/contact/index.json",
  "pages/contact/index.wxml",
  "pages/contact/index.wxss",
];
const helperPath = "apps/miniapp/utils/customer-service.js";
const allowedFiles = [
  ...templateFiles,
  "utils/customer-service.js",
  "contacts.public.js",
  "project.config.json",
  "ACCEPTANCE_MANIFEST.json",
].sort();
const fixtureContact = {
  provider: "wecom",
  available: true,
  corpId: "ww0000000000000000",
  url: "https://work.weixin.qq.com/kfid/kf_fixture_00001",
};
const fixtureEmergency = { configured: true, phone: "13800138000" };
function config(overrides = {}) {
  return {
    brandName: "Fixture",
    miniappAppId: "wxab76ea213eb6d01a",
    officialAccountId: "fixture",
    operatingMode: "DEVELOPMENT",
    serviceCity: "fixture",
    safetyHotlineAvailable: false,
    customerService: { ...fixtureContact },
    emergencyContact: { ...fixtureEmergency },
    integrations: { payment: "mock", sms: "mock", map: "mock" },
    features: {
      addressSuggestionAvailable: false,
      addressVerificationRequired: false,
    },
    ...overrides,
  };
}
const jsonResponse = (value) =>
  new Response(JSON.stringify({ data: value }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const publicContacts = (fetchImpl, options = {}) =>
  fetchPublicContacts({
    schema: PublicConfigSchema,
    fetchImpl,
    ...options,
  });

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zydj-contact-fixture-"));
  const expectedPrefix = `${resolve(tmpdir())}${sep}zydj-contact-fixture-`;
  assert.ok(resolve(directory).startsWith(expectedPrefix));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(expectedPrefix));
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of templateFiles) {
    const target = join(directory, "assets/contact-acceptance", name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      await readFile(join(root, "assets/contact-acceptance", name)),
    );
  }
  const helper = join(directory, helperPath);
  await mkdir(dirname(helper), { recursive: true });
  await writeFile(helper, await readFile(join(root, helperPath)));
  await writeFile(join(directory, ".gitignore"), ".codex-runtime/\n");
  git(directory, "init", "--quiet");
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture package inputs",
  );
  return directory;
}
async function allFiles(directory, prefix = "") {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory())
      files.push(...(await allFiles(join(directory, item.name), name)));
    else files.push(name);
  }
  return files.sort();
}
function packageFixture(
  directory,
  fetchImpl = async () => jsonResponse(config()),
) {
  return packageContactAcceptance({
    repoRoot: directory,
    schema: PublicConfigSchema,
    fetchImpl,
  });
}

test("CLI supports only an explicit bounded loopback port", () => {
  assert.deepEqual(parseArguments([]), { port: 5310 });
  assert.deepEqual(parseArguments(["--port", "5320"]), { port: 5320 });
  for (const args of [
    ["--url", "http://evil.test"],
    ["--port"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "5310/path"],
    ["--port", "05310"],
    ["--port", "5310", "extra"],
  ])
    assert.throws(() => parseArguments(args));
});

test("public-config URL refuses nonliteral loopback, credentials, extra paths, query, and fragments", () => {
  assert.equal(
    validatePublicConfigUrl("http://127.0.0.1:5310/v1/config/public"),
    "http://127.0.0.1:5310/v1/config/public",
  );
  assert.equal(
    validatePublicConfigUrl("http://127.0.0.1:80/v1/config/public"),
    "http://127.0.0.1/v1/config/public",
  );
  for (const url of [
    "http://localhost:5310/v1/config/public",
    "https://127.0.0.1:5310/v1/config/public",
    "http://127.1:5310/v1/config/public",
    "http://2130706433:5310/v1/config/public",
    "http://user:password@127.0.0.1:5310/v1/config/public",
    "http://127.0.0.1:5310/v1/config/public?key=fixture",
    "http://127.0.0.1:5310/v1/config/public#fixture",
    "http://127.0.0.1:5310/v1/config/public?",
    "http://127.0.0.1:5310/v1/config/public#",
    "http://127.0.0.1:5310/v1/other/../config/public",
    "http://127.0.0.1:5310/v1/config/public/",
    "http://evil.test:5310/v1/config/public",
  ])
    assert.throws(() => validatePublicConfigUrl(url));
});

test("fetch is fixed GET, timeout bounded, no redirects or credentials; only chosen public fields survive", async () => {
  const contacts = await publicContacts(
    async (url, options) => {
      assert.equal(url, "http://127.0.0.1:5320/v1/config/public");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(options.headers, { accept: "application/json" });
      return jsonResponse(
        config({
          fixturePrivateSecret: "do-not-copy-fixture",
          customerService: { ...fixtureContact, secret: "do-not-copy-fixture" },
        }),
      );
    },
    { port: 5320 },
  );
  assert.deepEqual(contacts, {
    customerService: fixtureContact,
    emergencyContact: fixtureEmergency,
  });
  assert.doesNotMatch(
    JSON.stringify(contacts),
    /do-not-copy|integrations|officialAccountId|miniappAppId/,
  );
});

test("network and redirect failures are sanitized and never retried", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      publicContacts(async () => {
        calls++;
        throw new Error("fixture-private-network-detail");
      }),
    (error) =>
      error.message === "Cannot read the loopback public configuration",
  );
  assert.equal(calls, 1);
  const redirected = jsonResponse(config());
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(
    () => publicContacts(async () => redirected),
    /not returned directly/,
  );
  const otherOrigin = jsonResponse(config());
  Object.defineProperty(otherOrigin, "url", { value: "https://evil.test" });
  await assert.rejects(
    () => publicContacts(async () => otherOrigin),
    /unexpected origin/,
  );
});

test("response status, JSON content type, advertised and streamed size are bounded", async () => {
  for (const response of [
    new Response("fixture", { status: 503 }),
    new Response(JSON.stringify({ data: config() }), {
      headers: { "content-type": "text/plain" },
    }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
    }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "invalid",
      },
    }),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
  ])
    await assert.rejects(() => publicContacts(async () => response));
});

test("Schema and readiness reject unavailable/mismatched/malicious contact data", async () => {
  for (const value of [
    {},
    config({ miniappAppId: "wx_fixture_other" }),
    config({ customerService: undefined }),
    config({ customerService: { ...fixtureContact, available: false } }),
    config({ customerService: { ...fixtureContact, corpId: "invalid" } }),
    config({
      customerService: { ...fixtureContact, url: "https://evil.test" },
    }),
    config({ customerService: { ...fixtureContact, provider: "none" } }),
    config({ customerService: { ...fixtureContact, corpId: "", url: "" } }),
    config({ emergencyContact: undefined }),
    config({ emergencyContact: { ...fixtureEmergency, configured: false } }),
    config({
      emergencyContact: { configured: true, phone: "13800138000;fixture" },
    }),
  ])
    await assert.rejects(() => publicContacts(async () => jsonResponse(value)));
});

test("existing compiled helper permits only contact/dialer/toast native APIs", async () => {
  const helper = await readFile(join(root, helperPath), "utf8");
  assert.equal(validateContactHelper(helper), helper);
  for (const attack of [
    "wx.request({});",
    "host.login({});",
    "host.requestPayment({});",
    "host.navigateTo({});",
    "host['request']({});",
    "fetch('https://evil.test');",
    "require('fixture');",
    "eval('fixture');",
  ])
    assert.throws(() => validateContactHelper(`${helper}\n${attack}`));
});

test("package is a committed, one-page, exact-whitelist artifact with public-only config and hashes", async (t) => {
  const directory = await fixture(t);
  const receipt = await packageFixture(directory, async () =>
    jsonResponse(config({ fixturePrivateSecret: "do-not-copy-fixture" })),
  );
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    receipt.path,
    join(
      directory,
      ".codex-runtime/miniapp-contact-acceptance",
      receipt.commit,
    ),
  );
  assert.deepEqual(receipt.files, allowedFiles);
  assert.deepEqual(await allFiles(receipt.path), allowedFiles);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    new RegExp(
      `${fixtureContact.corpId}|${fixtureEmergency.phone}|kfid|do-not-copy`,
    ),
  );
  const project = JSON.parse(
    await readFile(join(receipt.path, "project.config.json"), "utf8"),
  );
  assert.equal(project.appid, "wxab76ea213eb6d01a");
  assert.equal(project.setting.urlCheck, true);
  assert.equal(project.setting.uploadWithSourceMap, false);
  const app = JSON.parse(
    await readFile(join(receipt.path, "app.json"), "utf8"),
  );
  assert.deepEqual(app.pages, ["pages/contact/index"]);
  const manifestSource = await readFile(
    join(receipt.path, "ACCEPTANCE_MANIFEST.json"),
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(receipt.manifestSha256, hash(manifestSource));
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.commit, receipt.commit);
  assert.deepEqual(manifest.capabilities, [
    "openCustomerServiceChat",
    "makePhoneCall",
    "showToast",
  ]);
  for (const entry of manifest.files) {
    const content = await readFile(join(receipt.path, entry.path));
    assert.equal(entry.sha256, hash(content));
    assert.equal(entry.bytes, content.byteLength);
    assert.doesNotMatch(
      entry.path,
      /\.ts$|\.map$|private|node_modules|auth|orders|payments/,
    );
    assert.doesNotMatch(
      content.toString(),
      /do-not-copy-fixture|wx\.(?:request|login|requestPayment)\b/,
    );
    if (entry.path.endsWith(".js")) new vm.Script(content.toString());
  }
  const contacts = await readFile(
    join(receipt.path, "contacts.public.js"),
    "utf8",
  );
  const context = { module: { exports: {} } };
  vm.runInNewContext(contacts, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.module.exports)), {
    customerService: fixtureContact,
    emergencyContact: fixtureEmergency,
  });
});

test("repeat packaging refuses before fetching or overwriting", async (t) => {
  const directory = await fixture(t);
  const first = await packageFixture(directory);
  const original = await readFile(join(first.path, "contacts.public.js"));
  await assert.rejects(
    () => packageFixture(directory, () => assert.fail("Repeat must not fetch")),
    /already exists/,
  );
  assert.deepEqual(
    await readFile(join(first.path, "contacts.public.js")),
    original,
  );
});

test("uncommitted template/helper changes refuse before fetching", async (t) => {
  const directory = await fixture(t);
  await writeFile(
    join(directory, "assets/contact-acceptance/app.js"),
    "App({ fixture: true });\n",
  );
  await assert.rejects(
    () =>
      packageFixture(directory, () =>
        assert.fail("Dirty input must not fetch"),
      ),
    /differ from the current commit/,
  );
});

test("committed helper gaining a network capability is rejected before fetching", async (t) => {
  const directory = await fixture(t);
  const helper = await readFile(join(directory, helperPath), "utf8");
  await writeFile(join(directory, helperPath), `${helper}\nwx.request({});\n`);
  git(directory, "add", helperPath);
  git(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture forbidden API",
  );
  await assert.rejects(
    () =>
      packageFixture(directory, () =>
        assert.fail("Unsafe helper must not fetch"),
      ),
    /must not contain/,
  );
});

test("unready contact does not create an acceptance output directory", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    () =>
      packageFixture(directory, async () =>
        jsonResponse(
          config({ customerService: { ...fixtureContact, available: false } }),
        ),
      ),
    /Confirmed customer service/,
  );
  await assert.rejects(
    () => readdir(join(directory, ".codex-runtime/miniapp-contact-acceptance")),
    { code: "ENOENT" },
  );
});

test("template invokes contacts only on a user tap and gives no connection acknowledgement", async () => {
  const calls = [];
  const host = {
    openCustomerServiceChat: (value) => calls.push({ kind: "chat", value }),
    makePhoneCall: (value) => calls.push({ kind: "phone", value }),
    showToast: (value) => calls.push({ kind: "toast", value }),
  };
  const exports = {};
  vm.runInNewContext(await readFile(join(root, helperPath), "utf8"), {
    wx: host,
    exports,
  });
  let page;
  vm.runInNewContext(
    await readFile(
      join(root, "assets/contact-acceptance/pages/contact/index.js"),
      "utf8",
    ),
    {
      require: (name) =>
        name === "../../utils/customer-service"
          ? exports
          : {
              customerService: fixtureContact,
              emergencyContact: fixtureEmergency,
            },
      Page: (options) => {
        page = options;
      },
    },
  );
  page.data = structuredClone(page.data);
  page.setData = function (values) {
    Object.assign(this.data, values);
  };
  assert.equal(calls.length, 0);
  page.openCustomerService();
  assert.equal(calls[0].kind, "chat");
  assert.equal(calls[0].value.corpId, fixtureContact.corpId);
  page.callMerchantDuty();
  assert.equal(calls[1].kind, "phone");
  assert.equal(calls[1].value.phoneNumber, fixtureEmergency.phone);
  assert.equal(calls.length, 2);
  calls[0].value.fail({ errMsg: "fixture-private-detail" });
  assert.equal(calls[2].kind, "toast");
  assert.match(calls[2].value.title, /未打开/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.customerServiceDiagnostic)),
    {
      stage: "SDK_CALLBACK",
      code: "NOT_PROVIDED",
      signal: "UNKNOWN",
    },
  );
  page.openCustomerService();
  assert.equal(page.data.customerServiceDiagnostic, null);
  calls[0].value.fail({ errCode: 111 });
  assert.equal(
    calls.length,
    4,
    "a superseded failure must not show a stale toast",
  );
  assert.equal(
    page.data.customerServiceDiagnostic,
    null,
    "late errors from the previous tap must not replace current state",
  );
  calls[3].value.fail({
    errCode: 222,
    errMsg: "openCustomerServiceChat:fail permission denied",
  });
  assert.equal(page.data.customerServiceDiagnostic.code, "222");
  assert.equal(
    page.data.customerServiceDiagnostic.signal,
    "PERMISSION_WORDING",
  );
  assert.doesNotMatch(JSON.stringify(page.data), /fixture-private-detail/);
  assert.equal(
    calls.length,
    5,
    "the current failure must still show its fallback toast",
  );
  const markup = await readFile(
    join(root, "assets/contact-acceptance/pages/contact/index.wxml"),
    "utf8",
  );
  assert.match(markup, /不是商城经营版/);
  assert.match(markup, /打开客服入口不等于客服已接通/);
  assert.match(markup, /不是公共应急号码/);
  assert.match(markup, /打开拨号界面不等于电话已接通/);
  assert.match(markup, /诊断版 v2/);
  assert.match(markup, /线索不等于已查明原因/);
  assert.doesNotMatch(markup, /&amp;&amp;/);
});

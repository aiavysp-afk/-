import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = (path) =>
  readFileSync(new URL("../apps/miniapp/" + path, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
function fixture(
  handler = (request) =>
    request.success({
      statusCode: 201,
      data: { data: { receiptId: "demo-receipt", status: "PENDING_REVIEW" } },
    }),
) {
  let page;
  const requests = [],
    routes = [],
    changes = [],
    media = [];
  const exports = {};
  const context = {
    exports,
    Error,
    Promise,
    Math,
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(update) {
          changes.push(update);
          Object.assign(this.data, update);
        },
      };
    },
    getApp: () => ({
      globalData: { apiBaseUrl: "https://fixture.invalid/v1" },
    }),
    wx: {
      showShareMenu() {},
      request(options) {
        requests.push(options);
        handler(options);
      },
      login() {
        throw Error("No account login should be requested");
      },
      getStorageSync() {
        throw Error("No customer session should be read");
      },
      setStorageSync() {
        throw Error("Do not persist the applicant's private information");
      },
      chooseMedia(options) {
        media.push(options);
        options.success({
          tempFiles: [{ tempFilePath: "/tmp/certificate-original", size: 100 }],
        });
      },
      compressImage(options) {
        options.success({ tempFilePath: "/tmp/certificate-compressed" });
      },
      getFileSystemManager: () => ({
        readFile(options) {
          options.success({ data: "ZGVtby1jZXJ0" });
        },
      }),
      navigateTo: ({ url }) => routes.push(url),
      switchTab: ({ url }) => routes.push(url),
    },
  };
  vm.runInNewContext(compile("utils/simple-technician-intake.ts"), context);
  exports.registerSimpleTechnicianIntake();
  page.onLoad();
  return { page, requests, routes, changes, media };
}
function fill(page) {
  page.inputName({ detail: { value: "示例申请人" } });
  page.inputPhone({ detail: { value: "13900000001" } });
  page.toggleAccepted();
}
test("opening or sharing the form never signs in, reads accounts, or creates a record", () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  assert.equal(
    f.page.onShareAppMessage().path,
    "/pages/technician-onboarding/index",
  );
  f.page.openPrivacy();
  assert.deepEqual(f.routes, ["/pages/agreement/index?type=privacy"]);
});
test("name, valid phone, one photo and consent are required before a write", async () => {
  const f = fixture();
  await f.page.submit();
  assert.match(f.page.data.error, /姓名/);
  fill(f.page);
  await f.page.submit();
  assert.match(f.page.data.error, /证书照片/);
  f.page.certificateBase64 = "ZGVtby1jZXJ0";
  f.page.toggleAccepted();
  await f.page.submit();
  assert.match(f.page.data.error, /隐私政策/);
  assert.equal(f.requests.length, 0);
});
test("photo selection is explicit, supports camera and album, and performs no remote upload", async () => {
  const f = fixture();
  await f.page.chooseCertificate();
  assert.equal(f.media.length, 0);
  fill(f.page);
  await f.page.chooseCertificate();
  assert.equal(f.media[0].count, 1);
  assert.deepEqual(Array.from(f.media[0].sourceType), ["camera", "album"]);
  assert.equal(f.page.data.certificatePath, "/tmp/certificate-compressed");
  assert.equal(f.requests.length, 0);
});
test("the only write is anonymous and success clears private form data without opening a workbench", async () => {
  const f = fixture();
  fill(f.page);
  await f.page.chooseCertificate();
  await f.page.submit();
  assert.equal(f.requests.length, 1);
  const input = f.requests[0];
  assert.equal(input.url, "https://fixture.invalid/v1/technician/intake");
  assert.equal(input.method, "POST");
  assert.equal(input.header.Authorization, undefined);
  assert.match(
    input.header["Idempotency-Key"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(Object.keys(input.data).sort(), [
    "certificateBase64",
    "consentAccepted",
    "name",
    "phone",
  ]);
  assert.equal(input.data.consentAccepted, true);
  assert.equal(f.page.data.submitted, true);
  assert.equal(f.page.data.phone, "");
  assert.equal(f.page.certificateBase64, "");
  assert.deepEqual(f.routes, []);
  await f.page.submit();
  assert.equal(f.requests.length, 1);
});
test("double taps cannot race and an uncertain network result retries the same submission key", async () => {
  let pending;
  const f = fixture((request) => {
    pending = request;
  });
  fill(f.page);
  await f.page.chooseCertificate();
  const first = f.page.submit();
  await f.page.submit();
  assert.equal(f.requests.length, 1);
  pending.fail({ errMsg: "timeout" });
  await first;
  assert.equal(f.page.data.submitted, false);
  assert.equal(f.page.data.phone, "13900000001");
  const second = f.page.submit();
  assert.equal(
    f.requests[0].header["Idempotency-Key"],
    f.requests[1].header["Idempotency-Key"],
  );
  pending.success({
    statusCode: 201,
    data: { data: { receiptId: "demo-receipt", status: "PENDING_REVIEW" } },
  });
  await second;
  assert.equal(f.page.data.submitted, true);
});
test("a rejected or malformed response cannot display submitted; unloading prevents stale updates", async () => {
  for (const response of [
    { statusCode: 429, data: {} },
    {
      statusCode: 200,
      data: { data: { status: "APPROVED", receiptId: "demo-receipt" } },
    },
  ]) {
    const f = fixture((request) => request.success(response));
    fill(f.page);
    await f.page.chooseCertificate();
    await f.page.submit();
    assert.equal(f.page.data.submitted, false);
    assert.ok(f.page.data.error);
  }
  let pending;
  const f = fixture((request) => {
    pending = request;
  });
  fill(f.page);
  await f.page.chooseCertificate();
  const submitting = f.page.submit();
  f.page.onUnload();
  const count = f.changes.length;
  pending.success({
    statusCode: 201,
    data: { data: { receiptId: "demo-receipt", status: "PENDING_REVIEW" } },
  });
  await submitting;
  assert.equal(f.changes.length, count);
  assert.equal(f.page.certificateBase64, "");
});
test("old technician workbench and photo links only redirect to the one-way form", () => {
  for (const route of ["technician-workbench", "technician-photos"]) {
    let page;
    const urls = [];
    vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
      Page: (value) => {
        page = value;
      },
      wx: { redirectTo: ({ url }) => urls.push(url) },
    });
    page.onLoad();
    assert.deepEqual(urls, ["/pages/technician-onboarding/index"]);
  }
});

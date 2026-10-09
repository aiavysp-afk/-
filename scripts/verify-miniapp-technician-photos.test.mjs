import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = (path) => readFileSync(new URL(`../apps/miniapp/${path}`, import.meta.url), "utf8");
const compile = (path) => ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const profile = { technicianId: "self-tech", publicName: "", ageRange: null, avatarUrl: "", galleryUrls: [], introduction: "", specialties: [], status: "DRAFT" };
const session = (role) => ({ accessToken: "TEST-ONLY-TOKEN", user: { id: "self-tech", memberships: role ? [{ role, organizationId: "org" }] : [] } });

function helperFixture(login, current = { id: "self-tech", memberships: [] }) {
  const exports = {}, downloads = [], apiCalls = [];
  vm.runInNewContext(compile("utils/technician-photos.ts"), {
    exports, Error, Promise,
    require(name) {
      if (name === "./auth") return { getStoredSession: () => login };
      if (name === "./api") return { api: async (path) => { apiCalls.push(path); return current; } };
      throw new Error(`Unexpected helper dependency ${name}`);
    },
    getApp: () => ({ globalData: { apiBaseUrl: "https://api.fixture.invalid/v1" } }),
    wx: { downloadFile(options) { downloads.push(options); options.success({ statusCode: 200, tempFilePath: "private-local-preview.jpg" }); } },
  });
  return { exports, downloads, apiCalls };
}

function pageFixture(handler = () => profile) {
  let page;
  const apiCalls = [], toasts = [], selections = [];
  vm.runInNewContext(compile("pages/technician-photos/index.ts"), {
    exports: {}, Error, Promise,
    Page(definition) { page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } }; },
    wx: { showToast: (value) => toasts.push(value), navigateBack() {}, previewImage() {} },
    require(name) {
      if (name === "../../utils/auth") return { requireVerifiedCustomerAccess: () => true };
      if (name === "../../utils/api") return { api: async (path, method = "GET", data) => { apiCalls.push({ path, method, data }); return handler(path, method, data); } };
      if (name === "../../utils/technician-photos") return {
        chooseTechnicianPhoto: async () => { selections.push(true); return { base64: "TEST-ONLY-BASE64" }; },
        ownTechnicianPhotoPreview: async (_profile, url) => `private-${url}`,
      };
      throw new Error(`Unexpected page dependency ${name}`);
    },
  });
  page.data.profile = structuredClone(profile);
  return { page, apiCalls, toasts, selections };
}

test("ordinary customers never receive an upload entry, while real current memberships are refreshed", async () => {
  const customer = helperFixture(session());
  assert.equal(customer.exports.canUploadOwnTechnicianPhotos(), false);
  const owner = helperFixture(session("THERAPIST"));
  assert.equal(owner.exports.canUploadOwnTechnicianPhotos(), true);
  const newlyClaimed = helperFixture(session(), { id: "self-tech", memberships: [{ role: "THERAPIST", organizationId: "org" }] });
  assert.equal(await newlyClaimed.exports.refreshOwnTechnicianPhotoAccess(), true);
  assert.deepEqual(newlyClaimed.apiCalls, ["/auth/me"]);
  const differentUser = helperFixture(session(), { id: "another-user", memberships: [{ role: "THERAPIST" }] });
  assert.equal(await differentUser.exports.refreshOwnTechnicianPhotoAccess(), false);
});

test("private previews attach credentials only to same-API owner image routes", async () => {
  const fixture = helperFixture(session("THERAPIST"));
  const url = "https://api.fixture.invalid/v1/technicians/self-tech/photos/fixture-photo";
  assert.equal(await fixture.exports.ownTechnicianPhotoPreview(profile, url), "private-local-preview.jpg");
  assert.equal(fixture.downloads[0].url, "https://api.fixture.invalid/v1/technician/workbench/profile/photos/fixture-photo");
  assert.equal(fixture.downloads[0].header.Authorization, "Bearer TEST-ONLY-TOKEN");
  const legacyUrl = "https://cdn.fixture.invalid/photo.jpg";
  assert.equal(await fixture.exports.ownTechnicianPhotoPreview(profile, legacyUrl), legacyUrl);
  assert.equal(fixture.downloads.length, 1);
  await assert.rejects(() => fixture.exports.ownTechnicianPhotoPreview({ ...profile, technicianId: "other-tech" }, url), /只能预览本人/);
});

test("without explicit portrait permission the miniapp never selects or sends a photo", async () => {
  const fixture = pageFixture();
  await fixture.page.upload({ currentTarget: { dataset: { kind: "AVATAR" } } });
  assert.equal(fixture.apiCalls.length, 0);
  assert.equal(fixture.selections.length, 0);
  assert.match(fixture.toasts[0].title, /本人照片授权/);
});

test("owner upload body contains no arbitrary technician identifier or fabricated details", async () => {
  const latest = { ...profile, avatarUrl: "fixture-photo-url" };
  const fixture = pageFixture(() => ({ photoId: "photo", publicUrl: "fixture-photo-url", profile: latest }));
  fixture.page.data.authorized = true;
  await fixture.page.upload({ currentTarget: { dataset: { kind: "AVATAR" } } });
  assert.equal(fixture.apiCalls.length, 1);
  assert.equal(fixture.apiCalls[0].path, "/technician/workbench/profile/photos");
  assert.equal(fixture.apiCalls[0].method, "POST");
  assert.deepEqual(Object.keys(fixture.apiCalls[0].data).sort(), ["authorized", "base64", "kind"]);
  assert.equal(fixture.page.data.profile.publicName, "");
  assert.equal(fixture.page.data.avatarPreview, "private-fixture-photo-url");
});

test("photo-first draft stays saved and cannot be submitted with missing real introduction or specialties", async () => {
  const fixture = pageFixture();
  fixture.page.data.profile.avatarUrl = "already-saved-photo";
  await fixture.page.submitReview();
  assert.equal(fixture.apiCalls.length, 0);
  assert.match(fixture.toasts[0].title, /真实介绍和擅长/);
});

test("real owner introduction and specialties are saved before explicit review submission", async () => {
  const fixture = pageFixture((path) => ({ ...profile, avatarUrl: "already-saved-photo", introduction: "本人填写的真实介绍", specialties: ["肩颈舒缓"], status: path.endsWith("submit-review") ? "PENDING_REVIEW" : "DRAFT" }));
  fixture.page.data.profile.avatarUrl = "already-saved-photo";
  fixture.page.data.introduction = " 本人填写的真实介绍 ";
  fixture.page.data.specialties = "肩颈舒缓，肩颈舒缓";
  await fixture.page.submitReview();
  assert.equal(fixture.apiCalls[0].method, "PATCH");
  assert.deepEqual(Object.keys(fixture.apiCalls[0].data).sort(), ["introduction", "specialties"]);
  assert.equal(fixture.apiCalls[0].data.introduction, "本人填写的真实介绍");
  assert.equal(fixture.apiCalls[0].data.specialties.length, 1);
  assert.equal(fixture.apiCalls[1].path, "/technician/workbench/profile/submit-review");
  assert.equal(fixture.apiCalls[1].method, "POST");
  assert.equal(Object.keys(fixture.apiCalls[1].data).length, 0);
  assert.equal(fixture.page.data.profile.status, "PENDING_REVIEW");
  assert.match(fixture.page.data.message, /不会自动开通接单/);
});

test("client list/detail entries explicitly target only the uploader's own photo page", () => {
  for (const directory of ["therapists", "therapist-detail"]) {
    assert.match(source(`pages/${directory}/index.wxml`), /wx:if="\{\{canUploadOwnPhotos\}\}"/);
    assert.match(source(`pages/${directory}/index.wxml`), /本人技师照片/);
    assert.match(source(`pages/${directory}/index.ts`), /url: "\/pages\/technician-photos\/index"/);
    assert.doesNotMatch(source(`pages/${directory}/index.ts`), /technician-photos\/index\?/);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = (path) =>
  readFileSync(new URL(`../apps/miniapp/${path}`, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const profile = {
  technicianId: "self-tech",
  publicName: "",
  ageRange: null,
  avatarUrl: "",
  galleryUrls: [],
  introduction: "",
  specialties: [],
  status: "DRAFT",
};
const session = (role) => ({
  accessToken: "TEST-ONLY-TOKEN",
  user: {
    id: "self-tech",
    memberships: role ? [{ role, organizationId: "org" }] : [],
  },
});

function helperFixture(login, current = { id: "self-tech", memberships: [] }) {
  const exports = {},
    downloads = [],
    apiCalls = [];
  vm.runInNewContext(compile("utils/technician-photos.ts"), {
    exports,
    Error,
    Promise,
    require(name) {
      if (name === "./auth") return { getStoredSession: () => login };
      if (name === "./api")
        return {
          api: async (path) => {
            apiCalls.push(path);
            return current;
          },
        };
      throw new Error(`Unexpected helper dependency ${name}`);
    },
    getApp: () => ({
      globalData: { apiBaseUrl: "https://api.fixture.invalid/v1" },
    }),
    wx: {
      downloadFile(options) {
        downloads.push(options);
        options.success({
          statusCode: 200,
          tempFilePath: "private-local-preview.jpg",
        });
      },
    },
  });
  return { exports, downloads, apiCalls };
}

test("the retained portrait helper still limits portrait access to verified current memberships", async () => {
  const customer = helperFixture(session());
  assert.equal(customer.exports.canUploadOwnTechnicianPhotos(), false);
  const owner = helperFixture(session("THERAPIST"));
  assert.equal(owner.exports.canUploadOwnTechnicianPhotos(), true);
  const newlyClaimed = helperFixture(session(), {
    id: "self-tech",
    memberships: [{ role: "THERAPIST", organizationId: "org" }],
  });
  assert.equal(
    await newlyClaimed.exports.refreshOwnTechnicianPhotoAccess(),
    true,
  );
  assert.deepEqual(newlyClaimed.apiCalls, ["/auth/me"]);
  const differentUser = helperFixture(session(), {
    id: "another-user",
    memberships: [{ role: "THERAPIST" }],
  });
  assert.equal(
    await differentUser.exports.refreshOwnTechnicianPhotoAccess(),
    false,
  );
});

test("private previews attach credentials only to same-API owner image routes", async () => {
  const fixture = helperFixture(session("THERAPIST"));
  const url =
    "https://api.fixture.invalid/v1/technicians/self-tech/photos/fixture-photo";
  assert.equal(
    await fixture.exports.ownTechnicianPhotoPreview(profile, url),
    "private-local-preview.jpg",
  );
  assert.equal(
    fixture.downloads[0].url,
    "https://api.fixture.invalid/v1/technician/workbench/profile/photos/fixture-photo",
  );
  assert.equal(
    fixture.downloads[0].header.Authorization,
    "Bearer TEST-ONLY-TOKEN",
  );
  const legacyUrl = "https://cdn.fixture.invalid/photo.jpg";
  assert.equal(
    await fixture.exports.ownTechnicianPhotoPreview(profile, legacyUrl),
    legacyUrl,
  );
  assert.equal(fixture.downloads.length, 1);
  await assert.rejects(
    () =>
      fixture.exports.ownTechnicianPhotoPreview(
        { ...profile, technicianId: "other-tech" },
        url,
      ),
    /只能预览本人/,
  );
});

test("old technician workbench and photo URLs cannot select, upload, fetch private data or accept orders", () => {
  for (const route of ["technician-workbench", "technician-photos"]) {
    let page;
    const routes = [];
    vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
      Page: (definition) => {
        page = definition;
      },
      require: (name) => {
        throw Error(
          "Compatibility routes cannot import account or private APIs: " + name,
        );
      },
      wx: new Proxy(
        { redirectTo: ({ url }) => routes.push(url) },
        {
          get(target, key) {
            if (key in target) return target[key];
            throw Error("Unexpected account/photo/order action " + String(key));
          },
        },
      ),
    });
    page.onLoad({ technicianId: "other-person", orderId: "old-order" });
    assert.deepEqual(routes, ["/pages/technician-onboarding/index"]);
    assert.deepEqual(Object.keys(page), ["onLoad"]);
    assert.doesNotMatch(
      source("pages/" + route + "/index.wxml"),
      /button|input|<image|bindtap|wx:for|data-kind|授权|接单/,
    );
  }
});

test("registered historical technician URLs stay available as redirects, not broken deep links", () => {
  const app = JSON.parse(source("app.json"));
  for (const route of [
    "technician-onboarding",
    "technician-application",
    "technician-workbench",
    "technician-photos",
  ]) {
    assert.ok(app.pages.includes("pages/" + route + "/index"));
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = readFileSync(
  new URL(
    "../apps/miniapp/pages/technician-application/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const application = {
  id: "profile",
  status: "DRAFT",
  realName: "张三",
  serviceCity: "郑州市",
  serviceAreas: ["金水区"],
  availableTimeSlots: ["MON:09:00-18:00"],
  bio: "本人填写的真实服务经验介绍",
  serviceIds: ["service"],
  avatarUrl: "https://fixture.invalid/avatar.jpg",
  galleryUrls: [],
  hasIdFront: true,
  hasIdBack: true,
};
function fixture(handler, verified = true) {
  let page;
  const calls = [],
    selections = [],
    routes = [];
  vm.runInNewContext(compiled, {
    exports: {},
    Error,
    Promise,
    Set,
    Page(value) {
      page = {
        ...value,
        data: structuredClone(value.data),
        setData(data) {
          Object.assign(this.data, data);
        },
      };
    },
    require(name) {
      if (name === "../../utils/api")
        return {
          api: async (path, method = "GET", data) => {
            calls.push({ path, method, data });
            return handler
              ? handler(path, method, data)
              : path === "/catalog/services"
                ? [{ id: "service", name: "肩颈舒缓", durationMinutes: 60 }]
                : path === "/config/public"
                  ? { serviceCity: "郑州市" }
                  : { application: structuredClone(application) };
          },
        };
      if (name === "../../utils/auth")
        return {
          requireVerifiedCustomerAccess: () => verified,
          getStoredSession: () => ({ user: { id: "owner" } }),
        };
      if (name === "../../utils/technician-photos")
        return {
          chooseTechnicianPhoto: async () => {
            selections.push(true);
            return { path: "local-image.jpg", base64: "AAAA" };
          },
          ownTechnicianPhotoPreview: async (_owner, url) => url,
        };
      throw new Error(name);
    },
    wx: {
      redirectTo: (input) => routes.push(input.url),
      showToast() {},
      previewImage() {},
    },
  });
  return { page, calls, selections, routes };
}
test("native full form reads only owner material and current catalog after phone verification", async () => {
  const denied = fixture(null, false);
  await denied.page.onShow();
  assert.equal(denied.calls.length, 0);
  const f = fixture();
  await f.page.onShow();
  assert.equal(f.page.data.realName, "张三");
  assert.equal(f.page.data.services[0].checked, true);
  assert.equal(f.page.data.timeSlots[0].checked, true);
  assert.equal(f.page.data.application.hasIdBack, true);
});
test("submitted application returns to status screen rather than reopening editable material", async () => {
  const f = fixture((path) =>
    path === "/catalog/services"
      ? []
      : path === "/config/public"
        ? { serviceCity: "郑州市" }
        : { application: { ...application, status: "PENDING_REVIEW" } },
  );
  await f.page.onShow();
  assert.deepEqual(f.routes, ["/pages/technician-onboarding/index"]);
});
test("native upload requires consent and keeps identity images off public portrait endpoints", async () => {
  const f = fixture();
  await f.page.onShow();
  f.calls.length = 0;
  await f.page.upload({ currentTarget: { dataset: { kind: "ID_FRONT" } } });
  assert.equal(f.selections.length, 0);
  assert.equal(f.calls.length, 0);
  f.page.data.authorized = true;
  f.page.data.realName = "尚未保存的新姓名";
  await f.page.upload({ currentTarget: { dataset: { kind: "ID_FRONT" } } });
  assert.equal(f.calls[0].path, "/technician/onboarding/application/documents");
  assert.deepEqual(Object.keys(f.calls[0].data).sort(), [
    "contentBase64",
    "kind",
  ]);
  assert.equal(f.page.data.realName, "尚未保存的新姓名");
  assert.equal(f.page.data.idFrontPreview, "local-image.jpg");
});
test("complete native submission saves the same private record before explicit review", async () => {
  const f = fixture();
  await f.page.onShow();
  f.calls.length = 0;
  f.page.data.serviceAreas = " 金水区，金水区，中原区 ";
  await f.page.submitReview();
  assert.equal(f.calls[0].method, "PATCH");
  assert.deepEqual(Object.keys(f.calls[0].data).sort(), [
    "availableTimeSlots",
    "bio",
    "realName",
    "serviceAreas",
    "serviceCity",
    "serviceIds",
  ]);
  assert.equal(f.calls[0].data.serviceAreas.length, 2);
  assert.equal(f.calls[1].path, "/technician/onboarding/application/submit");
  assert.equal(f.calls[1].method, "POST");
  assert.deepEqual(f.routes, ["/pages/technician-onboarding/index"]);
});
test("missing ID back prevents native review submission even when portrait is saved", async () => {
  const f = fixture();
  await f.page.onShow();
  f.calls.length = 0;
  f.page.data.application.hasIdBack = false;
  await f.page.submitReview();
  assert.equal(f.calls.length, 0);
  assert.match(f.page.data.error, /身份证正反面/);
});
test("invalid or empty draft does not send a profile patch or review request", async () => {
  const f = fixture();
  await f.page.onShow();
  f.calls.length = 0;
  f.page.data.realName = "";
  await f.page.saveDraft();
  assert.equal(f.calls.length, 0);
  assert.match(f.page.data.error, /真实姓名/);
});

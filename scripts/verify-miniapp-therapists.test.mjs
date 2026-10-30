import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = (path) =>
  readFileSync(new URL("../apps/miniapp/" + path, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const service = {
  id: "service-one",
  slug: "regular-spa",
  name: "正规放松项目",
  category: "MASSAGE",
  subtitle: "项目说明",
  description: "项目描述",
  durationMinutes: 60,
  priceFen: 19800,
  steps: ["服务前沟通"],
  boundaries: ["非医疗服务"],
};

function fixture(route, verified = true) {
  let page;
  const routes = [],
    calls = [],
    toasts = [];
  vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
    exports: {},
    Error,
    Promise,
    Page(definition) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(values) {
          Object.assign(this.data, values);
        },
      };
    },
    require(name) {
      if (name === "../../utils/auth")
        return {
          requireVerifiedCustomerAccess: () => verified,
          hasVerifiedCustomerSession: () => verified,
        };
      if (name === "../../utils/api")
        return {
          money: (fen) => (fen / 100).toFixed(2),
          api: async (path) => {
            calls.push(path);
            assert.equal(path, "/catalog/services");
            return [service];
          },
        };
      if (name === "../../utils/tab-bar") return { syncCustomTabBar() {} };
      return new Proxy(
        {},
        {
          get: (_target, key) => () => {
            throw Error(
              "Unexpected profile/showcase API action " + String(key),
            );
          },
        },
      );
    },
    wx: {
      navigateTo: ({ url }) => routes.push(url),
      switchTab: ({ url }) => routes.push(url),
      showToast: (value) => toasts.push(value),
    },
  });
  return { page, routes, calls, toasts };
}

test("customer landing, discovery and service detail have no rendered technician directory or portrait controls", () => {
  for (const route of ["home", "discover", "service-detail"]) {
    const view = source("pages/" + route + "/index.wxml");
    assert.doesNotMatch(
      view,
      /wx:for="\{\{(?:allTherapists|therapists|showcasePhotos)\}\}"/,
    );
    assert.doesNotMatch(
      view,
      /(?:bind|catch)tap="(?:openTherapist|openTherapists|openAllTherapists|previewShowcase|loadShowcase)"/,
    );
    assert.doesNotMatch(
      view,
      /item\.(?:avatarUrl|galleryUrls)|新上线技师|本人技师照片/,
    );
  }
  assert.match(
    source("pages/home/index.wxml"),
    /bindtap="openTechnicianIntake"/,
  );
  assert.match(source("pages/home/index.wxml"), />技师入驻</);
});

test("discovery loads published services without fetching or creating technician cards", async () => {
  const f = fixture("discover");
  await f.page.onShow();
  assert.deepEqual(f.calls, ["/catalog/services"]);
  assert.equal(f.page.data.error, "");
  assert.equal(f.page.data.services[0].slug, service.slug);
  assert.equal(f.page.data.services[0].price, "198.00");
  assert.equal(f.page.data.therapists.length, 0);
  f.page.openService({ currentTarget: { dataset: { slug: service.slug } } });
  assert.deepEqual(f.routes, ["/pages/booking/index?slug=regular-spa"]);
});

test("a customer project card opens booking directly only after real availability is present", () => {
  const f = fixture("home");
  f.page.data.allServices = [
    {
      ...service,
      therapistId: "published-with-slot",
      bookingState: "AVAILABLE",
    },
  ];
  f.page.bookService({ currentTarget: { dataset: { slug: service.slug } } });
  assert.deepEqual(f.routes, ["/pages/booking/index?slug=regular-spa"]);
  assert.ok(f.routes.every((url) => !/therapist-detail|therapistId/.test(url)));
  f.routes.length = 0;
  f.page.data.allServices = [
    { ...service, therapistId: "", bookingState: "NO_SLOTS" },
  ];
  f.page.bookService({ currentTarget: { dataset: { slug: service.slug } } });
  f.page.bookService({
    currentTarget: { dataset: { slug: "unknown-service" } },
  });
  assert.deepEqual(f.routes, []);
  assert.equal(f.toasts.length, 1);
});

test("service information keeps its three customer tabs and opens booking without a technician directory hop", () => {
  const f = fixture("service-detail");
  assert.deepEqual(
    Array.from(f.page.data.tabs, (tab) => tab.label),
    ["项目介绍", "服务流程", "用户评价"],
  );
  f.page.chooseTechnician();
  assert.deepEqual(f.routes, []);
  f.page.data.service = service;
  f.page.data.preferredTherapistId = "query-injected-person";
  f.page.chooseTechnician();
  assert.deepEqual(f.routes, ["/pages/booking/index?slug=regular-spa"]);
  const denied = fixture("service-detail", false);
  denied.page.data.service = service;
  denied.page.chooseTechnician();
  assert.deepEqual(denied.routes, []);
});

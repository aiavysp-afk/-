import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const session = {
  accessToken: "synthetic-detail-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: { id: "fixture-customer", phoneVerified: true },
};
const service = {
  id: "fixture-service",
  slug: "fixture-spa",
  name: "测试项目",
  subtitle: "服务器卖点",
  description: "后台维护的真实项目说明",
  category: "SPA_RELAXATION",
  durationMinutes: 80,
  priceFen: 31234,
  featured: true,
  steps: ["服务器步骤一", "服务器步骤二"],
  boundaries: ["后台服务边界"],
};
const profile = {
  technicianId: "fixture-tech",
  publicName: "",
  avatarUrl: "https://example.test/reviewed.jpg",
  galleryUrls: [],
  introduction: "已审核介绍",
  specialties: ["测试项目"],
  certificates: [],
  serviceYears: null,
  freeTravelFee: true,
  travelFeeFen: 0,
  reviewSummary: { averageRating: null, reviewCount: 0, completedOrders: 0 },
};
const review = {
  id: "fixture-review",
  customerAlias: "顾客*",
  rating: 4,
  content: "合成评价仅用于测试",
  createdAt: "2026-10-10T08:00:00Z",
};

function loadPage(name = "service-detail") {
  let options;
  const previous = globalThis.Page;
  globalThis.Page = (page) => {
    options = page;
  };
  try {
    const path = `../apps/miniapp/pages/${name}/index.js`;
    delete require.cache[require.resolve(path)];
    require(path);
  } finally {
    globalThis.Page = previous;
  }
  return {
    ...options,
    data: structuredClone(options.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
}

async function host(
  callback,
  { authenticated = true, profiles = [profile], reply } = {},
) {
  const previousWx = globalThis.wx,
    previousApp = globalThis.getApp;
  const requests = [],
    navigations = [],
    scrolls = [],
    redirects = [];
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "https://fixture.test/v1" },
  });
  globalThis.wx = {
    getStorageSync: () => (authenticated ? session : undefined),
    removeStorageSync() {},
    reLaunch: (options) => {
      redirects.push(options.url);
      options.complete?.();
    },
    navigateTo: (options) => navigations.push(options.url),
    navigateBack() {},
    pageScrollTo: (options) => scrolls.push(options),
    request(input) {
      const path = input.url.slice("https://fixture.test/v1".length);
      requests.push({ path, method: input.method });
      assert.equal(
        input.method,
        "GET",
        "browsing details must never write or create an order",
      );
      if (reply?.(input, path)) return;
      const data =
        path === "/catalog/services/fixture-spa"
          ? service
          : path === "/catalog/services/fixture-spa/reviews"
            ? [review]
            : path === "/catalog/services"
              ? [service]
              : path === "/technicians"
                ? profiles
                : path.startsWith("/availability/slots?")
                  ? [
                      {
                        therapistId: "fixture-tech",
                        startsAt: "2099-01-01T00:00:00Z",
                        endsAt: "2099-01-01T01:20:00Z",
                      },
                    ]
                  : assert.fail(`unexpected request ${path}`);
      input.success({ statusCode: 200, data: { data } });
    },
  };
  try {
    await callback({ requests, navigations, scrolls, redirects });
  } finally {
    globalThis.wx = previousWx;
    globalThis.getApp = previousApp;
  }
}

test("detail reads authoritative description, amount, duration, configured process and reviews", async () =>
  host(async ({ navigations }) => {
    const page = loadPage();
    await page.onLoad({ slug: service.slug });
    assert.equal(page.data.service.price, "312.34");
    assert.equal(page.data.service.durationMinutes, 80);
    assert.equal(page.data.service.description, service.description);
    assert.deepEqual(page.data.service.process, [
      { number: "01", title: service.steps[0] },
      { number: "02", title: service.steps[1] },
    ]);
    assert.deepEqual(page.data.service.boundaries, service.boundaries);
    assert.equal(page.data.reviews[0].stars, "★★★★");
    assert.equal(page.data.reviews[0].dateLabel, "2026-10-10");
    assert.equal(
      page.data.therapists[0].alias,
      "",
      "missing optional name is not fabricated",
    );
    assert.equal(page.data.availabilityLabel, "1位技师可约");
    page.openTherapist({ currentTarget: { dataset: { id: "fixture-tech" } } });
    assert.deepEqual(navigations, [
      "/pages/therapist-detail/index?id=fixture-tech&slug=fixture-spa",
    ]);
  }));

test("catalog remains readable without published technicians and a preferred ID cannot open a fake booking", async () =>
  host(
    async ({ requests, navigations }) => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug, therapistId: "fake-tech" });
      assert.equal(page.data.service.name, service.name);
      assert.deepEqual(page.data.therapists, []);
      assert.equal(page.data.availabilityLabel, "预约时段待开放");
      assert.ok(
        !requests.some((item) => item.path.startsWith("/availability/")),
      );
      page.openTherapist({ currentTarget: { dataset: { id: "fake-tech" } } });
      assert.deepEqual(navigations, []);
    },
    { profiles: [] },
  ));

test("published profile without project slots cannot be selected", async () =>
  host(
    async ({ navigations }) => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.deepEqual(page.data.therapists, []);
      page.openTherapist({
        currentTarget: { dataset: { id: "fixture-tech" } },
      });
      assert.deepEqual(navigations, []);
    },
    {
      reply(input, path) {
        if (!path.startsWith("/availability/")) return false;
        input.success({ statusCode: 200, data: { data: [] } });
        return true;
      },
    },
  ));

test("a schedule failure is distinct from a confirmed empty state, never bookable", async () =>
  host(
    async () => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.ok(page.data.service);
      assert.ok(page.data.availabilityError);
      assert.equal(page.data.availabilityLabel, "排班待确认");
      assert.deepEqual(page.data.therapists, []);
    },
    {
      reply(input, path) {
        if (!path.startsWith("/availability/")) return false;
        input.fail();
        return true;
      },
    },
  ));

test("review failure does not fabricate empty successful reviews or hide the catalog", async () =>
  host(
    async () => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.ok(page.data.service);
      assert.ok(page.data.reviewsError);
      assert.deepEqual(page.data.reviews, []);
      assert.equal(page.data.therapists.length, 1);
    },
    {
      reply(input, path) {
        if (!path.endsWith("/reviews")) return false;
        input.fail();
        return true;
      },
    },
  ));

test("catalog fetch failure does not fall back to hardcoded prices or fake technicians", async () =>
  host(
    async ({ requests }) => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.equal(page.data.service, null);
      assert.ok(page.data.error);
      assert.equal(requests.length, 1);
    },
    {
      reply(input) {
        input.fail();
        return true;
      },
    },
  ));

test("wrong catalog response is refused and unknown or loading technician clicks are ignored", async () =>
  host(
    async ({ navigations }) => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.match(page.data.error, /不匹配/);
      assert.equal(page.data.service, null);
      page.openTherapist({
        currentTarget: { dataset: { id: "fixture-tech" } },
      });
      assert.deepEqual(navigations, []);
    },
    {
      reply(input, path) {
        if (path !== "/catalog/services/fixture-spa") return false;
        input.success({
          statusCode: 200,
          data: { data: { ...service, slug: "another" } },
        });
        return true;
      },
    },
  ));

test("nonzero travel fee blocks the detail's appointment list", async () =>
  host(
    async () => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      assert.ok(page.data.availabilityError.includes("出行费"));
      assert.deepEqual(page.data.therapists, []);
    },
    { profiles: [{ ...profile, freeTravelFee: false, travelFeeFen: 10 }] },
  ));

test("tabs accept only registered values and choose-technician button scrolls to visible content", async () =>
  host(async ({ scrolls }) => {
    const page = loadPage();
    await page.onLoad({ slug: service.slug });
    page.selectTab({ currentTarget: { dataset: { key: "UNKNOWN" } } });
    assert.equal(page.data.activeTab, "INTRO");
    page.selectTab({ currentTarget: { dataset: { key: "REVIEWS" } } });
    assert.equal(page.data.activeTab, "REVIEWS");
    page.chooseTechnician();
    assert.equal(page.data.activeTab, "TECHNICIANS");
    assert.deepEqual(scrolls, [{ scrollTop: 0, duration: 200 }]);
  }));

test("logout gate and missing slug never request or navigate into details", async () => {
  await host(
    async ({ requests, redirects }) => {
      const page = loadPage();
      await page.onLoad({ slug: service.slug });
      await page.onShow();
      assert.deepEqual(requests, []);
      assert.ok(redirects.length > 0);
    },
    { authenticated: false },
  );
  await host(async ({ requests }) => {
    const page = loadPage();
    await page.onLoad({});
    assert.ok(page.data.error);
    assert.deepEqual(requests, []);
  });
});

test("leaving during a fetch rejects stale responses without changing a destroyed page", async () => {
  let finish;
  await host(
    async () => {
      const page = loadPage();
      const pending = page.onLoad({ slug: service.slug });
      const state = structuredClone(page.data);
      page.onUnload();
      finish();
      await pending;
      assert.deepEqual(page.data, state);
    },
    {
      reply(input, path) {
        if (path !== "/catalog/services/fixture-spa") return false;
        finish = () =>
          input.success({ statusCode: 200, data: { data: service } });
        return true;
      },
    },
  );
});

test("home and services offer detail navigation independently of bookability without bypassing normal appointment checks", async () =>
  host(async ({ navigations }) => {
    for (const name of ["home", "services"]) {
      const page = loadPage(name);
      page.data[name === "home" ? "allServices" : "all"] = [
        { ...service, therapistId: "", bookingState: "NO_PROFILE" },
      ];
      page.openServiceDetail({
        currentTarget: { dataset: { slug: service.slug } },
      });
      page.openServiceDetail({
        currentTarget: { dataset: { slug: "unknown" } },
      });
      const source = readFileSync(
        new URL(`../apps/miniapp/pages/${name}/index.wxml`, import.meta.url),
        "utf8",
      );
      assert.match(source, /catchtap="openServiceDetail"/);
    }
    assert.deepEqual(navigations, [
      "/pages/service-detail/index?slug=fixture-spa",
      "/pages/service-detail/index?slug=fixture-spa",
    ]);
  }));

test("details label visual artwork honestly and present published process rather than a manufactured fixed treatment", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/service-detail/index.wxml", import.meta.url),
    "utf8",
  );
  assert.match(source, /视觉示意 · 非服务实拍/);
  assert.match(source, /service\.process/);
  assert.match(source, /service\.boundaries/);
  assert.match(source, /9项预约提醒/);
  assert.doesNotMatch(source, /疗效保证|百分百好评|包治|fake-tech/);
});

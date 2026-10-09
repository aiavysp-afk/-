import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pagePath = "../apps/miniapp/pages/home/index.js";
const session = {
  accessToken: "synthetic-home-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: { id: "synthetic-customer", phoneVerified: true },
};
const service = (id, name, category, priceFen, durationMinutes) => ({
  id,
  slug: id,
  name,
  category,
  priceFen,
  durationMinutes,
  subtitle: "正规非医疗放松服务",
  description: "仅用于本地行为测试的合成服务",
  featured: true,
  steps: [],
  boundaries: ["非医疗服务"],
});
const services = [
  service("tuina", "中式推拿", "MASSAGE", 21_800, 60),
  service("french", "法式 SPA", "SPA_RELAXATION", 49_800, 120),
  service("ear", "非遗采耳", "FOOT_CARE", 23_800, 70),
];
const profile = (id, specialties = []) => ({
  technicianId: id,
  publicName: `公开昵称-${id}`,
  avatarUrl: "https://cdn.example.test/portrait.jpg",
  galleryUrls: [],
  introduction: "合成审核资料",
  specialties,
  serviceYears: null,
  certificates: [],
  reviewSummary: { averageRating: null, reviewCount: 0, completedOrders: 0 },
  freeTravelFee: true,
  travelFeeFen: 0,
  status: "PUBLISHED",
});

const loadPage = () => {
  let options;
  const previous = globalThis.Page;
  globalThis.Page = (page) => {
    options = page;
  };
  try {
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
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
};

async function host(callback, { authenticated = true, reply } = {}) {
  const priorWx = globalThis.wx;
  const priorApp = globalThis.getApp;
  const requests = [],
    navigations = [],
    toasts = [];
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "http://fixture.test/v1" },
  });
  globalThis.wx = {
    getStorageSync: (key) =>
      key === "zydj.auth.session" && authenticated ? session : undefined,
    setStorageSync() {},
    removeStorageSync() {},
    reLaunch(input) {
      navigations.push(input.url);
      input.complete?.();
    },
    navigateTo: (input) => navigations.push(input.url),
    switchTab: (input) => navigations.push(input.url),
    showToast: (input) => toasts.push(input.title),
    request(input) {
      const path = input.url.replace("http://fixture.test/v1", "");
      requests.push({ path, method: input.method, data: input.data });
      if (reply) return reply(input, path);
      input.success({ statusCode: 200, data: { data: [] } });
    },
  };
  try {
    await callback({ requests, navigations, toasts });
  } finally {
    globalThis.wx = priorWx;
    globalThis.getApp = priorApp;
  }
}

test("home keeps actual published catalog prices, orders recommendations and filters categories", async () => {
  await host(
    async () => {
      const page = loadPage();
      await page.loadServices();
      assert.deepEqual(
        page.data.services.map((row) => row.slug),
        ["french", "tuina", "ear"],
      );
      assert.equal(page.data.services[0].price, "498.00");
      assert.equal(page.data.services[0].duration, "120 分钟");
      assert.equal(page.data.services[0].therapistId, "");
      page.selectCategory({ currentTarget: { dataset: { key: "RELAX" } } });
      assert.deepEqual(
        page.data.services.map((row) => row.slug),
        ["tuina"],
      );
      page.selectCategory({ currentTarget: { dataset: { key: "CARE" } } });
      assert.deepEqual(
        page.data.services.map((row) => row.slug),
        ["french", "ear"],
      );
    },
    {
      reply: (input) =>
        input.success({ statusCode: 200, data: { data: services } }),
    },
  );
});

test("home technician stream excludes profiles without slots and preserves approved express tags", async () => {
  await host(
    async () => {
      const page = loadPage();
      await Promise.all([page.loadServices(), page.loadTherapists()]);
      assert.deepEqual(
        page.data.therapists.map((row) => row.id),
        ["z-new", "a-old"],
      );
      assert.equal(page.data.therapists[0].express, true);
      assert.equal(page.data.therapists[1].express, false);
      assert.equal(page.data.services[0].therapistId, "z-new");
      assert.equal(page.data.services[0].bookableCount, 2);
      assert.equal(page.data.services[1].bookableCount, 0);
    },
    {
      reply(input, path) {
        const value =
          path === "/catalog/services"
            ? services
            : path === "/technicians"
              ? [
                  profile("z-new", ["极速达"]),
                  profile("a-old"),
                  profile("no-shift"),
                ]
              : path.includes("serviceId=french")
                ? ["z-new", "a-old"].map((id) => ({
                    therapistId: id,
                    startsAt: "2099-01-01T00:00:00.000Z",
                    endsAt: "2099-01-01T02:00:00.000Z",
                  }))
                : [];
        input.success({ statusCode: 200, data: { data: value } });
      },
    },
  );
});

test("service selection opens the matching real technician detail; unavailable services do not open booking", async () => {
  await host(async ({ navigations, toasts }) => {
    const page = loadPage();
    page.data.allServices = services;
    page.data.allTherapists = [
      { id: "actual-tech", services: [{ id: "french", slots: [{}] }] },
    ];
    page.applyCategory();
    page.bookService({ currentTarget: { dataset: { slug: "french" } } });
    assert.equal(
      navigations[0],
      "/pages/therapist-detail/index?id=actual-tech&slug=french",
    );
    page.bookService({ currentTarget: { dataset: { slug: "tuina" } } });
    assert.equal(navigations.length, 1);
    assert.deepEqual(toasts, ["该项目暂无可预约技师"]);
  });
});

test("visitor actions redirect to login and never issue a coupon claim", async () => {
  await host(
    async ({ requests, navigations }) => {
      const page = loadPage();
      await page.loadNewcomer();
      await page.claimNewcomer();
      page.selectCategory({ currentTarget: { dataset: { key: "CARE" } } });
      page.bookService({ currentTarget: { dataset: { slug: "french" } } });
      assert.deepEqual(requests, []);
      assert.equal(page.data.activeCategory, "POPULAR");
      assert.ok(
        navigations.every(
          (url) => url === "/pages/phone-verification/index?required=1",
        ),
      );
    },
    { authenticated: false },
  );
});

test("loading newcomer eligibility does not grant coupons; manual repeated claim sends one request", async () => {
  let finishClaim;
  await host(
    async ({ requests, navigations }) => {
      const page = loadPage();
      await page.loadNewcomer();
      assert.deepEqual(
        requests.map((input) => input.method),
        ["GET"],
      );
      const pending = page.claimNewcomer();
      await page.claimNewcomer();
      assert.equal(
        requests.filter((input) => input.method === "POST").length,
        1,
      );
      finishClaim();
      await pending;
      assert.equal(page.data.newcomerClaimed, true);
      await page.claimNewcomer();
      assert.equal(
        requests.filter((input) => input.method === "POST").length,
        1,
      );
      assert.equal(navigations[0], "/pages/coupons/index");
    },
    {
      reply(input) {
        const deliver = () =>
          input.success({
            statusCode: 200,
            data: {
              data: {
                claimed: input.method === "POST",
                eligible: input.method === "GET",
                reason:
                  input.method === "POST"
                    ? "新人优惠券已领取"
                    : "可领取新人优惠券",
              },
            },
          });
        if (input.method === "POST") finishClaim = deliver;
        else deliver();
      },
    },
  );
});

test("coupon lookup failure stays retryable and never claims success", async () => {
  await host(
    async () => {
      const page = loadPage();
      await page.loadNewcomer();
      assert.equal(page.data.newcomerAvailable, false);
      assert.equal(page.data.newcomerClaimed, false);
      assert.ok(page.data.newcomerError);
    },
    { reply: (input) => input.fail({ errMsg: "fixture network failure" }) },
  );
});

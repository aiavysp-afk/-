import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildPublicTherapists,
  loadPublicTherapists,
} = require("../apps/miniapp/utils/therapists.js");

const service = (id, slug, name, priceFen = 19_800) => ({
  id,
  slug,
  name,
  category: "MASSAGE",
  subtitle: `${name}说明`,
  description: `${name}描述`,
  durationMinutes: 60,
  priceFen,
  featured: true,
  steps: ["服务前沟通"],
  boundaries: ["正规服务"],
});

const slot = (therapistId, startsAt) => ({
  therapistId,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
});

const profile = (technicianId, publicName) => ({
  technicianId,
  displayName: publicName,
  publicName,
  avatarUrl: null,
  galleryUrls: [],
  introduction: "",
  specialties: [],
  serviceYears: null,
  certificates: [],
  reviewSummary: {
    averageRating: null,
    reviewCount: 0,
    completedOrders: 0,
  },
  recentReviews: [],
  status: "PUBLISHED",
  rejectionReason: null,
  freeTravelFee: true,
  travelFeeFen: 0,
  updatedAt: "2026-10-08T01:00:00.000Z",
});

test("public technician cards merge approved profiles with real availability", () => {
  const therapists = buildPublicTherapists(
    [
      {
        service: service("svc-a", "relax-a", "肩颈舒缓"),
        today: [slot("tech-b", "2026-10-08T04:00:00.000Z")],
        tomorrow: [slot("tech-a", "2026-10-09T03:00:00.000Z")],
      },
      {
        service: service("svc-b", "relax-b", "足部舒缓", 26_800),
        today: [slot("tech-b", "2026-10-08T05:00:00.000Z")],
        tomorrow: [],
      },
    ],
    [profile("tech-a", "已公开技师 A"), profile("tech-b", "已公开技师 B")],
  );

  assert.equal(therapists.length, 2);
  assert.equal(therapists[0].id, "tech-a");
  assert.equal(therapists[0].alias, "已公开技师 A");
  assert.equal(therapists[0].statusLabel, "明日可约");
  assert.equal(therapists[0].services.length, 1);
  assert.equal(therapists[1].id, "tech-b");
  assert.equal(therapists[1].alias, "已公开技师 B");
  assert.equal(therapists[1].statusLabel, "今日可约");
  assert.equal(therapists[1].services.length, 2);
  assert.equal(therapists[1].services[1].price, "268.00");
  assert.equal(therapists[1].ratingLabel, "暂无评价");
  assert.equal(therapists[1].orderCountLabel, "0单已完成");
  assert.equal(therapists[1].travelLabel, "免出行费");
});

test("an approved profile without shifts remains visible but cannot be booked", () => {
  const therapists = buildPublicTherapists(
    [],
    [profile("tech-a", "已公开技师 A")],
  );
  assert.equal(therapists.length, 1);
  assert.equal(therapists[0].bookable, false);
  assert.equal(therapists[0].statusLabel, "暂不可约");
  assert.equal(therapists[0].services.length, 0);
});

test("availability without an approved public profile is not exposed", () => {
  const therapists = buildPublicTherapists([
    {
      service: service("svc-a", "relax-a", "肩颈舒缓"),
      today: [slot("private-tech", "2026-10-08T04:00:00.000Z")],
      tomorrow: [],
    },
  ]);
  assert.deepEqual(therapists, []);
});

test("a blank optional public name remains blank and never exposes an internal display name", () => {
  const entry = profile("tech-a", "");
  entry.displayName = "private legal name";
  const [technician] = buildPublicTherapists([], [entry]);
  assert.equal(technician.alias, "");
  assert.notEqual(technician.alias, entry.displayName);
});

const withPublicApi = async (reply, callback) => {
  const oldWx = globalThis.wx;
  const oldApp = globalThis.getApp;
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "https://public.fixture.test/v1" },
  });
  globalThis.wx = {
    getStorageSync: () => undefined,
    removeStorageSync() {},
    request(input) {
      reply(input, input.url.replace("https://public.fixture.test/v1", ""));
    },
  };
  try {
    await callback();
  } finally {
    globalThis.wx = oldWx;
    globalThis.getApp = oldApp;
  }
};

test("technician detail loading keeps healthy real schedules when another project fails", async () => {
  await withPublicApi(
    (input, path) => {
      if (path.includes("serviceId=svc-b"))
        return input.fail({ errMsg: "fixture failure" });
      const data =
        path === "/technicians"
          ? [profile("tech-a", ""), profile("tech-b", "")]
          : path === "/catalog/services"
            ? [service("svc-a", "a", "项目A"), service("svc-b", "b", "项目B")]
            : [slot("tech-a", "2099-01-01T00:00:00.000Z")];
      input.success({ statusCode: 200, data: { data } });
    },
    async () => {
      const technicians = await loadPublicTherapists();
      assert.equal(
        technicians.find((item) => item.id === "tech-a").bookable,
        true,
      );
      const incomplete = technicians.find((item) => item.id === "tech-b");
      assert.equal(incomplete.bookable, false);
      assert.equal(incomplete.statusLabel, "排班待确认");
      assert.equal(incomplete.earliestLabel, "排班读取不完整");
    },
  );
});

test("a full schedule outage is an error, not a fabricated unbookable status", async () => {
  await withPublicApi(
    (input, path) => {
      if (path.startsWith("/availability/"))
        return input.fail({ errMsg: "fixture outage" });
      input.success({
        statusCode: 200,
        data: {
          data:
            path === "/technicians"
              ? [profile("tech-a", "")]
              : [service("svc-a", "a", "项目A")],
        },
      });
    },
    async () => {
      await assert.rejects(loadPublicTherapists(), /项目排班读取失败/);
    },
  );
});

test("unsafe travel fees block discovery rather than showing a false free-travel claim", async () => {
  const entry = profile("tech-a", "");
  entry.travelFeeFen = 100;
  await withPublicApi(
    (input, path) => {
      input.success({
        statusCode: 200,
        data: { data: path === "/technicians" ? [entry] : [] },
      });
    },
    async () => {
      await assert.rejects(loadPublicTherapists(), /出行费配置异常/);
    },
  );
});

test("technician pages disclose missing public data instead of hard-coding claims", () => {
  const list = readFileSync(
    new URL("../apps/miniapp/pages/therapists/index.wxml", import.meta.url),
    "utf8",
  );
  const detail = readFileSync(
    new URL(
      "../apps/miniapp/pages/therapist-detail/index.wxml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(list, /不使用虚构姓名、照片、评分或订单量/);
  assert.match(detail, /暂无公开服务相册/);
  assert.match(detail, /暂无已公开评价/);
  assert.match(list + detail, /免出行费/);
  assert.doesNotMatch(list + detail, /4\.8分|5\.0分|玲儿|清源/);
});

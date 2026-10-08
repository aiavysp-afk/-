import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildPublicTherapists,
} = require("../apps/miniapp/utils/therapists.js");

const profile = {
  technicianId: "tech-1",
  displayName: "公开昵称",
  publicName: "公开昵称",
  avatarUrl: "https://cdn.example.test/tech-1.jpg",
  galleryUrls: ["https://cdn.example.test/tech-1-gallery.jpg"],
  introduction: "技师本人填写并通过审核的公开介绍",
  specialties: ["肩颈舒缓"],
  serviceYears: 3,
  certificates: ["已审核资质"],
  reviewSummary: {
    averageRating: 4.8,
    reviewCount: 6,
    completedOrders: 18,
  },
  recentReviews: [],
  status: "PUBLISHED",
  rejectionReason: null,
  freeTravelFee: true,
  travelFeeFen: 0,
  updatedAt: "2026-10-08T12:00:00.000Z",
};

const service = {
  id: "service-1",
  slug: "shoulder-relax",
  name: "肩颈舒缓",
  subtitle: "正规放松服务",
  category: "MASSAGE",
  durationMinutes: 60,
  priceFen: 19_800,
  boundaries: ["非医疗服务"],
};

test("technician cards use only the shared published profile and real slots", () => {
  const result = buildPublicTherapists(
    [
      {
        service,
        today: [
          {
            therapistId: "tech-1",
            startsAt: "2026-10-08T12:00:00.000Z",
            endsAt: "2026-10-08T13:00:00.000Z",
          },
        ],
        tomorrow: [],
      },
    ],
    [profile],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].alias, profile.publicName);
  assert.equal(result[0].profile, profile.introduction);
  assert.equal(result[0].avatarUrl, profile.avatarUrl);
  assert.deepEqual(result[0].qualifications, profile.certificates);
  assert.equal(result[0].ratingLabel, "4.8分 · 6条");
  assert.equal(result[0].orderCountLabel, "18单已完成");
  assert.equal(result[0].travelLabel, "免出行费");
  assert.equal(result[0].bookable, true);
});

test("a published technician without a real shift stays visible but cannot be booked", () => {
  const [result] = buildPublicTherapists([], [profile]);
  assert.equal(result.alias, profile.publicName);
  assert.equal(result.bookable, false);
  assert.equal(result.statusLabel, "暂不可约");
  assert.equal(result.earliestLabel, "暂无可约时间");
});

test("a scheduled technician without a published profile is never exposed", () => {
  const result = buildPublicTherapists(
    [
      {
        service,
        today: [
          {
            therapistId: "internal-tech-without-public-profile",
            startsAt: "2026-10-08T12:00:00.000Z",
            endsAt: "2026-10-08T13:00:00.000Z",
          },
        ],
        tomorrow: [],
      },
    ],
    [],
  );
  assert.deepEqual(result, []);
});

test("miniapp reads shared technician profiles and verified reviews", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/utils/therapists.ts", import.meta.url),
    "utf8",
  );
  const detail = readFileSync(
    new URL(
      "../apps/miniapp/pages/therapist-detail/index.wxml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /api<TechnicianProfile\[]>\("\/technicians"\)/);
  assert.match(
    source,
    /\/technicians\/\$\{encodeURIComponent\(technicianId\)\}\/reviews/,
  );
  assert.doesNotMatch(
    source,
    /profile\?\.(?:bio|serviceTags|storeName|yearsExperience|qualifications)/,
  );
  assert.match(detail, /therapist\.galleryUrls/);
  assert.match(detail, /therapist\.qualifications/);
  assert.match(detail, /item\.customerAlias/);
  assert.match(detail, /免出行费/);
});

test("completed orders can be reviewed and cancelled orders are only soft-hidden", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/orders/index.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../apps/miniapp/pages/orders/index.wxml", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /order\.status === "COMPLETED" && order\.reviewStatus === null/,
  );
  assert.match(source, /评价待审核/);
  assert.match(source, /order\.reviewStatus === "PENDING_REVIEW"/);
  assert.match(source, /评价已公开/);
  assert.match(source, /评价未公开/);
  assert.match(source, /`\/orders\/\$\{this\.data\.reviewOrderId\}\/reviews`/);
  assert.match(
    source,
    /\["CANCELLED", "REFUNDED"\]\.includes\(order\.status\)/,
  );
  assert.match(source, /api\(`\/orders\/\$\{id\}`, "DELETE"\)/);
  assert.match(source, /不会硬删除/);
  assert.match(page, /评价本次服务/);
  assert.match(page, /提交评价审核/);
  assert.match(page, /审核通过后才公开/);
  assert.match(page, /从我的订单移除/);
});

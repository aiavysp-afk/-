import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildPublicTherapists,
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

test("public technician cards are built only from real availability slots", () => {
  const therapists = buildPublicTherapists([
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
  ]);

  assert.equal(therapists.length, 2);
  assert.equal(therapists[0].id, "tech-a");
  assert.equal(therapists[0].alias, "认证技师 01");
  assert.equal(therapists[0].statusLabel, "明日可约");
  assert.equal(therapists[0].services.length, 1);
  assert.equal(therapists[1].id, "tech-b");
  assert.equal(therapists[1].alias, "认证技师 02");
  assert.equal(therapists[1].statusLabel, "今日可约");
  assert.equal(therapists[1].services.length, 2);
  assert.equal(therapists[1].services[1].price, "268.00");
  assert.equal(therapists[1].ratingLabel, "暂无公开评分");
  assert.equal(therapists[1].orderCountLabel, "履约数据待授权");
  assert.equal(therapists[1].travelLabel, "出行费按地址报价");
});

test("technicians with no published slots are not invented", () => {
  const therapists = buildPublicTherapists([
    {
      service: service("svc-a", "relax-a", "肩颈舒缓"),
      today: [],
      tomorrow: [],
    },
  ]);
  assert.deepEqual(therapists, []);
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
  assert.doesNotMatch(list + detail, /4\.8分|5\.0分|免出行费|玲儿|清源/);
});

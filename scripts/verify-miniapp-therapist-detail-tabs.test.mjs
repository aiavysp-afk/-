import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = (extension) => readFileSync(new URL(`../apps/miniapp/pages/therapist-detail/index.${extension}`, import.meta.url), "utf8");
const compiled = ts.transpileModule(source("ts"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const project = (slug, featured = false) => ({
  id: `service-${slug}`, slug, name: `项目 ${slug}`, featured,
  priceFen: 29_800, price: "298.00", durationMinutes: 80,
  category: "MASSAGE", subtitle: "真实后台卖点", description: "真实服务说明",
  steps: ["沟通"], boundaries: ["非医疗"],
  slots: [{ therapistId: "tech-public", startsAt: "2099-01-01T02:00:00Z", dayLabel: "今天", timeLabel: "10:00" }],
});
const therapistFixture = () => ({
  id: "tech-public", alias: "", avatarUrl: "https://fixture.invalid/approved-photo.jpg",
  avatarIndex: 0, galleryUrls: [], qualifications: [], profile: "本人公开的真实介绍",
  ratingLabel: "暂无评价", completedOrdersLabel: "0单", yearsExperienceLabel: "待公开",
  statusLabel: "今日可约", statusTone: "online", travelLabel: "免出行费", tags: [],
  services: [project("featured", true), project("selected"), project("other")],
  reviews: [], reviewCount: 0, bookable: true,
});

function fixture({ therapist = therapistFixture(), authorized = true, photos = false, failure } = {}) {
  let page;
  const calls = [], toasts = [], routes = [], back = [];
  vm.runInNewContext(compiled, {
    exports: {}, Error, Promise, encodeURIComponent,
    Page(definition) {
      page = {
        ...definition, data: structuredClone(definition.data),
        setData(values) { Object.assign(this.data, values); },
      };
    },
    require(name) {
      if (name === "../../utils/therapists") return {
        loadPublicTherapist: async (id) => {
          calls.push(id);
          if (failure) throw failure;
          return structuredClone(therapist);
        },
      };
      if (name === "../../utils/auth") return { requireVerifiedCustomerAccess: () => authorized };
      if (name === "../../utils/technician-photos") return {
        canUploadOwnTechnicianPhotos: () => photos,
        refreshOwnTechnicianPhotoAccess: async () => photos,
      };
      throw new Error(`Unexpected dependency ${name}`);
    },
    wx: {
      showToast(value) { toasts.push(value); },
      navigateTo(value) { routes.push(value.url); },
      navigateBack(value) { back.push(value.delta); },
    },
  });
  return { page, calls, toasts, routes, back };
}
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
const slugs = (page) => Array.from(page.data.displayedServices, (service) => service.slug);

test("four detail tabs exist and recommendations use server featured data", async () => {
  const { page, calls } = fixture();
  await page.onLoad({ id: "tech-public" });
  assert.deepEqual(calls, ["tech-public"]);
  assert.equal(Array.from(page.data.tabs, (tab) => tab.label).join("/"), "推荐项目/全部项目/用户评论/商户动态");
  assert.equal(page.data.activeTab, "recommended");
  assert.deepEqual(slugs(page), ["featured"]);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.therapist.alias, "");
  assert.equal(page.data.canUploadOwnPhotos, false);
});

test("a real selected non-featured project stays first without dropping other projects", async () => {
  const { page } = fixture();
  await page.onLoad({ id: "tech-public", slug: "selected" });
  assert.equal(page.data.selectedServiceSlug, "selected");
  assert.deepEqual(slugs(page), ["selected", "featured"]);
  page.selectTab(event("tab", "all"));
  assert.deepEqual(slugs(page), ["selected", "featured", "other"]);
  page.selectTab(event("tab", "recommended"));
  assert.deepEqual(slugs(page), ["selected", "featured"]);
});

test("reviews and updates do not manufacture projects, reviews or dynamics", async () => {
  const { page } = fixture();
  await page.onLoad({ id: "tech-public" });
  for (const tab of ["reviews", "updates"]) {
    page.selectTab(event("tab", tab));
    assert.equal(page.data.activeTab, tab);
    assert.deepEqual(slugs(page), []);
  }
  assert.equal(page.data.therapist.reviews.length, 0);
  assert.equal(page.data.therapist.reviewCount, 0);
  page.selectTab(event("tab", "invalid"));
  assert.equal(page.data.activeTab, "updates");
});

test("no recommendations has an honest empty state with a usable all-projects action", async () => {
  const therapist = therapistFixture();
  therapist.services.forEach((service) => { service.featured = false; });
  const { page } = fixture({ therapist });
  await page.onLoad({ id: "tech-public" });
  assert.deepEqual(slugs(page), []);
  page.showAllProjects();
  assert.equal(page.data.activeTab, "all");
  assert.deepEqual(slugs(page), ["featured", "selected", "other"]);
});

test("an unavailable selected project is disclosed and never inserted into server projects", async () => {
  const { page, toasts } = fixture();
  await page.onLoad({ id: "tech-public", slug: "unavailable" });
  assert.equal(page.data.selectedServiceSlug, "");
  assert.match(toasts[0].title, /暂无可约时间/);
  assert.deepEqual(slugs(page), ["featured"]);
  assert.equal(page.data.therapist.services.length, 3);
});

test("project details preserve the actual technician context and reject unknown project links", async () => {
  const therapist = therapistFixture();
  therapist.id = "tech & public";
  therapist.services = [project("real & service", true)];
  const { page, routes } = fixture({ therapist });
  await page.onLoad({ id: "tech & public" });
  page.openService(event("slug", "real & service"));
  assert.deepEqual(routes, ["/pages/service-detail/index?slug=real%20%26%20service&therapistId=tech%20%26%20public"]);
  page.openService(event("slug", "unknown"));
  assert.equal(routes.length, 1);
});

test("book keeps the real slot guard and only routes valid projects", async () => {
  const { page, routes, toasts } = fixture();
  await page.onLoad({ id: "tech-public" });
  page.book(event("slug", "featured"));
  assert.deepEqual(routes, ["/pages/booking/index?slug=featured&therapistId=tech-public"]);
  page.data.therapist.services[0].slots = [];
  page.book(event("slug", "featured"));
  page.book(event("slug", "unknown"));
  assert.equal(routes.length, 1);
  assert.equal(toasts.length, 2);
  assert.ok(toasts.every((toast) => /暂无可约时间/.test(toast.title)));
});

test("customer access and own-photo permission remain enforced", async () => {
  const anonymous = fixture({ authorized: false });
  await anonymous.page.onLoad({ id: "tech-public" });
  anonymous.page.data.therapist = therapistFixture();
  anonymous.page.book(event("slug", "featured"));
  anonymous.page.openService(event("slug", "featured"));
  anonymous.page.openOwnPhotos();
  assert.equal(anonymous.calls.length, 0);
  assert.equal(anonymous.routes.length, 0);
  const customer = fixture();
  customer.page.openOwnPhotos();
  assert.equal(customer.routes.length, 0);
  const technician = fixture({ photos: true });
  await technician.page.onLoad({ id: "tech-public" });
  technician.page.openOwnPhotos();
  assert.deepEqual(technician.routes, ["/pages/technician-photos/index"]);
});

test("missing parameters and server failure leave no fabricated therapist content", async () => {
  const missing = fixture();
  await missing.page.onLoad({});
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.page.data.loading, false);
  assert.match(missing.page.data.error, /缺少技师参数/);
  const failed = fixture({ failure: new Error("真实排班服务不可用") });
  await failed.page.onLoad({ id: "tech-public" });
  assert.equal(failed.page.data.loading, false);
  assert.equal(failed.page.data.therapist, null);
  assert.match(failed.page.data.error, /真实排班服务不可用/);
});

test("detail markup includes honest empty illustrations, approved photos and readable project metadata", () => {
  const markup = source("wxml");
  assert.match(markup, /src="\{\{therapist.avatarUrl\}\}"/);
  assert.match(markup, /只展示本人授权且后台审核通过的照片/);
  assert.match(markup, /暂无已公开评价/);
  assert.match(markup, /暂无公开商户动态/);
  assert.match(markup, /项目示意/);
  assert.match(markup, /\{\{item.durationMinutes\}\}分钟/);
  assert.match(markup, /去预约/);
  assert.match(markup, /empty-art comment-art/);
  assert.match(markup, /empty-art update-art/);
  assert.doesNotMatch(markup, /实名认证|100%|实时动态|5\.0分|极速达/);
  const styles = source("wxss");
  assert.match(styles, /\.project-subtitle[^\n]*font-size: 27rpx[^\n]*font-weight: 550/);
  assert.match(styles, /\.project-meta[^\n]*font-size: 26rpx[^\n]*font-weight: 600/);
  assert.match(styles, /\.travel-note[^\n]*font-size: 25rpx/);
  assert.match(styles, /\.status\s*\{[^}]*position: static[^}]*width: auto[^}]*height: auto[^}]*border: 0/);
});

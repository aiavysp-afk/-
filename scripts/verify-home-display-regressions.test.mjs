import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test("campaign modal stays outside the animated page's transformed containing block", () => {
  const source = readFileSync(new URL("../apps/miniapp/pages/home/index.wxml", import.meta.url), "utf8");
  const overlay = source.indexOf('class="campaign-overlay"');
  assert.ok(overlay > 0);
  const opening = source.lastIndexOf('<view', overlay);
  let depth = 0;
  for (const match of source.slice(0,opening).matchAll(/<(\/?)(view)\b[^>]*>/g)) {
    if (match[1]) depth--;
    else if (!match[0].endsWith('/>')) depth++;
  }
  assert.equal(depth,0,"fixed overlay must be a root sibling, not a child of animated .page");
});
import { allowedAdminMethods } from "./serve-production-private-admin.mjs";
test("showcase management is restricted to the exact private PATCH resource", () => {
  assert.deepEqual(allowedAdminMethods("/v1/admin/organizations/org/technicians/tech/profile/showcase"), ["PATCH"]);
  assert.equal(allowedAdminMethods("/v1/admin/organizations/org/technicians/tech/profile/showcase/extra"), undefined);
  const nginx = readFileSync(new URL("../infra/nginx.production.conf", import.meta.url), "utf8");
  assert.match(nginx, /location ~ \^\/v1\/technician-showcase\(\?:\/photos\/\[A-Za-z0-9-\]\+\)\?\$ \{/);
  assert.match(nginx, /profile\/showcase\$ \{\s*if \(\$request_method != PATCH\)/);
});
const campaign = {
  organizationId: "org",
  version: 2,
  enabled: true,
  frequency: "DAILY",
  title: "新人优惠",
  imagePath: null,
};
function fixture() {
  let page,
    fail = false;
  const storage = new Map(),
    calls = [];
  const campaignUtils = require("../apps/miniapp/utils/home-campaign.js");
  vm.runInNewContext(
    readFileSync(
      new URL("../apps/miniapp/pages/home/index.js", import.meta.url),
      "utf8",
    ),
    {
      exports: {},
      Date,
      Page(value) {
        page = value;
      },
      getApp: () => ({ globalData: { apiBaseUrl: "https://fixture.test/v1" } }),
      wx: {
        getStorageSync: (key) => storage.get(key),
        setStorageSync: (key, value) => storage.set(key, value),
        showToast: (value) => calls.push(value),
      },
      require(path) {
        if (path.endsWith("/home-campaign")) return campaignUtils;
        if (path.endsWith("/api"))
          return {
            async api() {
              if (fail) throw new Error("fixture network error");
              return campaign;
            },
          };
        return {};
      },
    },
  );
  page.setData = (value) => Object.assign(page.data, value);
  return {
    page,
    storage,
    calls,
    setFail: (value) => {
      fail = value;
    },
  };
}
test("location/background interruption does not consume the campaign; explicit dismissal does", async () => {
  const { page, storage } = fixture();
  await page.loadCampaign();
  assert.equal(page.data.campaignVisible, true);
  assert.equal(storage.size, 0);
  page.onHide();
  await page.loadCampaign();
  assert.equal(page.data.campaignVisible, true);
  page.closeCampaign();
  assert.equal(storage.size, 1);
  await page.loadCampaign();
  assert.equal(page.data.campaignVisible, false);
  assert.equal(page.data.campaign.title, campaign.title); // Persistent entry remains.
  await page.loadCampaign(true);
  assert.equal(page.data.campaignVisible, true);
});
test("a failed manual campaign reload leaves a visible retry message", async () => {
  const { page, calls, setFail } = fixture();
  setFail(true);
  await page.loadCampaign(true);
  assert.match(calls[0].title, /读取失败/);
  assert.equal(page.data.campaignVisible, false);
});
test("portrait showcase cannot navigate to booking or accept arbitrary image URLs", async () => {
  let apiReply = [
    { id: "photo-1", imagePath: "/technician-showcase/photos/photo-1" },
    { id: "bad", imagePath: "https://evil.invalid/private" },
  ];
  let module = { exports: {} },
    preview;
  vm.runInNewContext(
    readFileSync(
      new URL("../apps/miniapp/utils/technician-showcase.js", import.meta.url),
      "utf8",
    ),
    {
      exports: module.exports,
      getApp: () => ({ globalData: { apiBaseUrl: "https://fixture.test/v1" } }),
      require: () => ({ api: async () => apiReply }),
      wx: {
        previewImage: (value) => {
          preview = value;
        },
      },
    },
  );
  const rows = await module.exports.loadShowcasePortraits();
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].imageUrl,
    "https://fixture.test/v1/technician-showcase/photos/photo-1",
  );
  module.exports.previewShowcasePortrait(rows, "unknown");
  assert.equal(preview, undefined);
  module.exports.previewShowcasePortrait(rows, "photo-1");
  assert.equal(preview.urls.length, 1);
});

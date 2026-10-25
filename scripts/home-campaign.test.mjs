import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldShowCampaign,
  chinaDay,
} from "../apps/miniapp/utils/home-campaign.ts";
import { allowedAdminMethods } from "./serve-production-private-admin.mjs";
test("daily campaign resets at China midnight, once stays hidden and new version can show", () => {
  const c = {
    organizationId: "org",
    version: 2,
    enabled: true,
    startsAt: null,
    endsAt: null,
    frequency: "DAILY",
  };
  const before = Date.parse("2026-10-25T15:59:59Z"),
    after = before + 1000;
  const saved = { identity: "org:2", day: chinaDay(before) };
  assert.equal(shouldShowCampaign(c, saved, before), false);
  assert.equal(shouldShowCampaign(c, saved, after), true);
  assert.equal(
    shouldShowCampaign({ ...c, frequency: "ONCE" }, saved, after),
    false,
  );
  assert.equal(shouldShowCampaign({ ...c, version: 3 }, saved, after), true);
  assert.equal(shouldShowCampaign(null, saved), false);
  assert.equal(shouldShowCampaign({ ...c, enabled: false }, null), false);
  assert.equal(
    shouldShowCampaign({ ...c, endsAt: "2026-10-25T00:00:00Z" }, null, after),
    false,
  );
});
test("private campaign editing exposes only GET/PATCH for the exact organization resource", () => {
  assert.deepEqual(
    allowedAdminMethods(
      "/v1/admin/organizations/org/customer-center/home-campaign",
    ),
    ["GET", "PATCH"],
  );
  assert.equal(
    allowedAdminMethods(
      "/v1/admin/organizations/org/customer-center/home-campaign/unknown",
    ),
    undefined,
  );
});

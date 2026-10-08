import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(
  new URL("../infra/nginx.production.conf", import.meta.url),
  "utf8",
);

test("production nginx exposes every customer authentication route", () => {
  for (const route of [
    "wechat-miniapp",
    "wechat-phone",
    "sms-phone/(?:request|confirm)",
    "me",
    "logout",
  ]) {
    assert.ok(config.includes(route), `missing route expression: ${route}`);
  }
});

test("production nginx keeps unknown API paths closed", () => {
  assert.match(config, /return 404/);
  assert.doesNotMatch(config, /location \/v1\/ \{/);
});

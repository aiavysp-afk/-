import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function checkBindings(source) {
  for (const match of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const expression = match[1];
    // WXML's expression compiler sees the semicolon in HTML-escaped operators.
    assert.doesNotMatch(
      expression,
      /&(?:amp|gt|lt|quot|apos|#\d+|#x[0-9a-f]+);/i,
    );
    // Parse only: never evaluate a page expression or run its function body.
    assert.doesNotThrow(() => new Function(`return (${expression});`));
  }
}
test("every source WXML binding has no HTML-escaped operators and parses", () => {
  const pages = readdirSync(new URL("../apps/miniapp/pages/", import.meta.url));
  assert.ok(pages.length >= 8);
  for (const page of pages) {
    const source = readFileSync(
      new URL(`../apps/miniapp/pages/${page}/index.wxml`, import.meta.url),
      "utf8",
    );
    checkBindings(source);
  }
});
test("guard catches the reported escaped AND regression but allows ordinary text entities", () => {
  assert.throws(() =>
    checkBindings('<view wx:if="{{loggedIn &amp;&amp; !loading}}"/>'),
  );
  assert.throws(() => checkBindings('<view wx:if="{{size &gt; 0}}"/>'));
  assert.doesNotThrow(() =>
    checkBindings('<text>A &amp; B</text><view wx:if="{{showEmpty}}"/>'),
  );
});

function loadPage(path) {
  let page;
  const previous = globalThis.Page;
  globalThis.Page = (options) => {
    page = options;
  };
  try {
    delete require.cache[require.resolve(path)];
    require(path);
  } finally {
    globalThis.Page = previous;
  }
  return {
    ...page,
    data: structuredClone(page.data),
    setData(values) {
      Object.assign(this.data, values);
    },
  };
}
async function host(callback, request, session) {
  const priorWx = globalThis.wx,
    priorGetApp = globalThis.getApp;
  globalThis.getApp = () => ({
    globalData: { apiBaseUrl: "http://fixture.test/v1" },
  });
  globalThis.wx = {
    getStorageSync: () => session,
    removeStorageSync() {},
    request,
  };
  try {
    await callback();
  } finally {
    globalThis.wx = priorWx;
    globalThis.getApp = priorGetApp;
  }
}
const session = {
  accessToken: "synthetic-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: { id: "fixture-user" },
};
test("compiled orders empty state is hidden until a successful authenticated empty response", async () => {
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/orders/index.js");
      const promise = page.load();
      assert.equal(page.data.showEmptyOrders, false);
      await promise;
      assert.equal(page.data.showEmptyOrders, true);
    },
    (input) => input.success({ statusCode: 200, data: { data: [] } }),
    session,
  );
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/orders/index.js");
      page.data.showEmptyOrders = true;
      await page.load();
      assert.equal(page.data.showEmptyOrders, false);
    },
    () => assert.fail("anonymous load must not request"),
    undefined,
  );
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/orders/index.js");
      await page.load();
      assert.equal(page.data.showEmptyOrders, false);
      assert.ok(page.data.error);
    },
    (input) => input.fail({ errMsg: "synthetic failure" }),
    session,
  );
});
test("compiled services empty state distinguishes successful empty category from loading and errors", async () => {
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/services/index.js");
      const promise = page.load();
      assert.equal(page.data.showEmptyServices, false);
      await promise;
      assert.equal(page.data.showEmptyServices, true);
      page.data.all = [{ category: "MASSAGE", id: "fixture" }];
      page.data.active = 1;
      page.filter();
      assert.equal(page.data.showEmptyServices, false);
      page.data.active = 2;
      page.filter();
      assert.equal(page.data.showEmptyServices, true);
      page.data.loading = true;
      page.filter();
      assert.equal(page.data.showEmptyServices, false);
    },
    (input) => input.success({ statusCode: 200, data: { data: [] } }),
    undefined,
  );
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/services/index.js");
      await page.load();
      assert.equal(page.data.showEmptyServices, false);
      assert.ok(page.data.error);
    },
    (input) => input.fail({ errMsg: "synthetic failure" }),
    undefined,
  );
});

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
  checkBindings(
    readFileSync(
      new URL("../apps/miniapp/custom-tab-bar/index.wxml", import.meta.url),
      "utf8",
    ),
  );
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
    reLaunch: ({ complete }) => complete?.(),
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
  user: { id: "fixture-user", phoneVerified: true },
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

test("profile keeps the confirmed emergency fallback when the API is unavailable", async () => {
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/profile/index.js");
      assert.deepEqual(page.data.emergencyContact, {
        configured: true,
        phone: "18018181799",
      });
      await page.onShow();
      assert.equal(page.data.emergencyContact.configured, true);
    },
    (input) => input.fail({ errMsg: "synthetic maintenance failure" }),
    session,
  );
});

test("a successful public-config response replaces the emergency fallback", async () => {
  const serverConfig = {
    customerService: {
      provider: "none",
      available: false,
      corpId: "",
      url: "",
    },
    emergencyContact: { configured: false, phone: "" },
  };
  await host(
    async () => {
      const page = loadPage("../apps/miniapp/pages/profile/index.js");
      await page.onShow();
      assert.deepEqual(
        page.data.emergencyContact,
        serverConfig.emergencyContact,
      );
    },
    (input) => input.success({ statusCode: 200, data: { data: serverConfig } }),
    session,
  );
});

test("profile exposes only the native WeChat customer-service channel", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/profile/index.wxml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /企业微信客服|openCustomerService/);
  assert.match(source, /open-type="contact"/);
});

test("compiled miniapp points real-device previews at the configured HTTPS API", () => {
  for (const file of ["app.ts", "app.js"]) {
    const source = readFileSync(
      new URL(`../apps/miniapp/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /https:\/\/api\.mtsc\.top\/v1/);
    assert.doesNotMatch(source, /localhost|127\.0\.0\.1|http:\/\//);
  }
});

test("all miniapp buttons resolve to handlers and all navigator targets are registered", () => {
  const app = JSON.parse(
    readFileSync(new URL("../apps/miniapp/app.json", import.meta.url), "utf8"),
  );
  const registered = new Set(app.pages.map((page) => `/${page}`));
  const tabPages = new Set(app.tabBar.list.map((item) => `/${item.pagePath}`));
  assert.equal(app.tabBar.custom, true);
  assert.deepEqual([...tabPages], [
    "/pages/home/index",
    "/pages/services/index",
    "/pages/therapists/index",
    "/pages/orders/index",
    "/pages/profile/index",
  ]);

  for (const pagePath of app.pages) {
    const directory = pagePath.replace(/^pages\//, "").replace(/\/index$/, "");
    const source = readFileSync(
      new URL(`../apps/miniapp/pages/${directory}/index.wxml`, import.meta.url),
      "utf8",
    );
    const page = loadPage(`../apps/miniapp/pages/${directory}/index.js`);
    for (const match of source.matchAll(
      /\b(?:bind|catch)(?:tap|change|input)="([A-Za-z_$][\w$]*)"/g,
    )) {
      assert.equal(
        typeof page[match[1]],
        "function",
        `${pagePath} is missing handler ${match[1]}`,
      );
    }
    for (const match of source.matchAll(/<navigator\b[^>]*\burl="([^"?]+)[^"]*"/g)) {
      assert.ok(
        registered.has(match[1]),
        `${pagePath} navigates to unregistered page ${match[1]}`,
      );
      const tag = match[0];
      if (/open-type="switchTab"/.test(tag))
        assert.ok(
          tabPages.has(match[1]),
          `${pagePath} switchTab target is not a tab page: ${match[1]}`,
        );
    }
  }
});

test("custom tab bar matches app configuration and routes every item", () => {
  let component;
  const previous = globalThis.Component;
  globalThis.Component = (options) => {
    component = options;
  };
  try {
    delete require.cache[
      require.resolve("../apps/miniapp/custom-tab-bar/index.js")
    ];
    require("../apps/miniapp/custom-tab-bar/index.js");
  } finally {
    globalThis.Component = previous;
  }
  assert.equal(component.data.list.length, 5);
  const routed = [];
  const previousWx = globalThis.wx;
  globalThis.wx = {
    getStorageSync: () => session,
    removeStorageSync() {},
    reLaunch: ({ complete }) => complete?.(),
    switchTab: ({ url }) => routed.push(url),
  };
  try {
    for (let index = 0; index < component.data.list.length; index += 1) {
      const context = {
        data: { ...component.data, selected: index === 0 ? 4 : index - 1 },
      };
      component.methods.switchTab.call(context, {
        currentTarget: { dataset: { index } },
      });
    }
  } finally {
    globalThis.wx = previousWx;
  }
  assert.deepEqual(
    routed,
    component.data.list.map((item) => item.pagePath),
  );
});

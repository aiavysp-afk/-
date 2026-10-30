import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = (path) =>
  readFileSync(new URL("../apps/miniapp/" + path, import.meta.url), "utf8");
const compile = (path) =>
  ts.transpileModule(source(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

test("old technician list and detail links with a service slug open the service information only", () => {
  for (const route of ["therapists", "therapist-detail"]) {
    let page;
    const routes = [];
    vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
      Page: (value) => {
        page = value;
      },
      require: (name) => {
        throw Error(
          "Compatibility route cannot load accounts or technician data: " +
            name,
        );
      },
      wx: {
        redirectTo: ({ url }) => routes.push(["redirect", url]),
        switchTab: ({ url }) => routes.push(["tab", url]),
      },
    });
    page.onLoad({ id: "old-tech-id", slug: "spa&therapistId=other" });
    assert.deepEqual(routes, [
      [
        "redirect",
        "/pages/service-detail/index?slug=spa%26therapistId%3Dother",
      ],
    ]);
    assert.deepEqual(Object.keys(page), ["onLoad"]);
  }
});

test("old technician links without a valid service route to the customer service tab", () => {
  for (const route of ["therapists", "therapist-detail"]) {
    for (const options of [
      {},
      { id: "old-tech-id" },
      { slug: "x".repeat(161) },
    ]) {
      let page;
      const routes = [];
      vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
        Page: (value) => {
          page = value;
        },
        wx: {
          redirectTo: ({ url }) => routes.push(["redirect", url]),
          switchTab: ({ url }) => routes.push(["tab", url]),
        },
      });
      page.onLoad(options);
      assert.deepEqual(routes, [["tab", "/pages/services/index"]]);
    }
    assert.doesNotMatch(
      source("pages/" + route + "/index.wxml"),
      /wx:for|<image|bindtap|getPhoneNumber|资质|已入驻|接单/,
    );
  }
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

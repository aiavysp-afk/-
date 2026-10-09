import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const source = readFileSync("apps/miniapp/pages/orders/index.ts", "utf8");
const compiled = readFileSync("apps/miniapp/pages/orders/index.js", "utf8");
const template = readFileSync("apps/miniapp/pages/orders/index.wxml", "utf8");

function fixture({ selected = 0, confirm = true, postFails = false } = {}) {
  const calls = [];
  const storage = new Map();
  const order = {
    id: "safety-order-1",
    orderNo: "SAFETY_FIXTURE_1",
    status: "IN_SERVICE",
    appointmentStart: "2099-01-01T01:00:00.000Z",
    payableFen: 19_800,
    safetyAvailable: true,
    safetyIncidents: [],
    refunds: [],
  };
  async function api(path, method = "GET", data, key) {
    calls.push({ path, method, data, key });
    if (path === "/orders") return [order];
    if (path.endsWith("/refunds")) return [];
    if (path.endsWith("/safety-incidents") && method === "GET") return [];
    if (path.endsWith("/safety-incidents") && method === "POST") {
      if (postFails) throw new Error("Synthetic safety write failed");
      return { id: "incident-1", status: "OPEN" };
    }
    throw new Error(`Unexpected path ${path}`);
  }
  const wx = {
    showActionSheet(input) {
      if (selected === null) input.fail?.();
      else input.success?.({ tapIndex: selected });
    },
    showModal(input) {
      if (input.title === "确认记录安全事件")
        input.success?.({ confirm, cancel: !confirm });
      input.complete?.();
    },
    showToast() {},
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
  };
  let definition;
  vm.runInNewContext(compiled, {
    exports: {},
    wx,
    Page(value) {
      definition = value;
    },
    require(name) {
      if (name === "../../utils/friend-payment") return require("../apps/miniapp/utils/friend-payment.js");
      if (name === "../../utils/api")
        return {
          api,
          money: (fen) => (fen / 100).toFixed(2),
          shanghaiTime: () => "Synthetic time",
          newKey: () => "synthetic-safety-key-0001",
        };
      if (name === "../../utils/auth")
        return {
          getStoredSession: () => ({
            accessToken: "fixture",
            user: { phoneVerified: true },
          }),
          loginWithWechat: async () => ({}),
          needsPhoneVerification: () => false,
          goToPhoneVerification() {},
        };
      if (name === "../../utils/tab-bar")
        return { syncCustomTabBar() {} };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const page = {
    ...definition,
    data: { ...definition.data, loggedIn: true, orders: [order] },
    setData(value) {
      Object.assign(this.data, value);
    },
  };
  return { page, calls, storage };
}

const safetyEvent = {
  currentTarget: { dataset: { id: "safety-order-1", action: "safety" } },
};

test("customer safety action uses fixed categories and an idempotent order endpoint", () => {
  for (const category of [
    "PERSONAL_SAFETY",
    "MEDICAL_CONCERN",
    "SERVICE_DISPUTE",
    "OTHER_URGENT",
  ])
    assert.match(source, new RegExp(category));
  assert.match(source, /zydj\.safety\.key\.\$\{id\}\.\$\{category\.value\}/);
  assert.match(source, /`\/orders\/\$\{id\}\/safety-incidents`/);
  assert.match(source, /\{ category: category\.value \}/);
  assert.match(compiled, /\/safety-incidents/);
});

test("safety submission requires an explicit user choice and confirmation", () => {
  assert.match(source, /wx\.showActionSheet/);
  assert.match(source, /title: "确认记录安全事件"/);
  assert.match(source, /if \(!confirmed\) return/);
  assert.match(template, /data-action="safety" bindtap="action"/);
  assert.match(template, /disabled="\{\{!!busy\}\}"/);
});

test("customer copy never claims notification delivery and names public emergency fallback", () => {
  assert.match(source, /不代表人工已经接通/);
  assert.match(source, /系统记录不等于通知送达/);
  assert.match(source, /立即报警或呼叫急救/);
  assert.doesNotMatch(source, /已通知值班人员|已接通值班人员|报警已完成/);
});

test("customer view neither renders internal responder ids nor permits duplicate unresolved events", () => {
  assert.doesNotMatch(template, /primaryUserId|backupUserId|acknowledgedById/);
  assert.match(
    source,
    /!safetyIncidents\.some\(\(incident\) => incident\.status !== "CLOSED"\)/,
  );
  assert.match(template, /incident\.statusLabel/);
});

test("confirmed safety action sends exactly one fixed-category request with a reusable key", async () => {
  const f = fixture({ selected: 1, confirm: true });
  await f.page.action(safetyEvent);
  const posts = f.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/safety-incidents"),
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/orders/safety-order-1/safety-incidents");
  assert.equal(posts[0].data.category, "MEDICAL_CONCERN");
  assert.equal(posts[0].key, "synthetic-safety-key-0001");
  assert.equal(f.storage.size, 0);
});

test("dismissed category or confirmation never creates a safety event", async () => {
  for (const options of [
    { selected: null, confirm: true },
    { selected: 0, confirm: false },
  ]) {
    const f = fixture(options);
    await f.page.action(safetyEvent);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("a failed safety write retains the same idempotency key for a deliberate retry", async () => {
  const f = fixture({ postFails: true });
  await f.page.action(safetyEvent);
  assert.equal(
    f.storage.get("zydj.safety.key.safety-order-1.PERSONAL_SAFETY"),
    "synthetic-safety-key-0001",
  );
  assert.ok(f.page.data.error);
});

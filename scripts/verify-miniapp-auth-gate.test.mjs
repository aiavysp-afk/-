import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const authPath = "../apps/miniapp/utils/auth.js";
const storageKey = "zydj.auth.session";

const session = (phoneVerified) => ({
  accessToken: "x".repeat(40),
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: {
    id: "customer-1",
    displayName: "微信用户",
    phoneVerified,
    memberships: [],
  },
});

function loadAuth(storedSession) {
  const previousWx = globalThis.wx;
  const redirects = [];
  globalThis.wx = {
    getStorageSync: (key) => (key === storageKey ? storedSession : undefined),
    removeStorageSync() {},
    reLaunch: (options) => {
      redirects.push(options.url);
      options.complete?.();
    },
  };
  delete require.cache[require.resolve(authPath)];
  const auth = require(authPath);
  return {
    auth,
    redirects,
    restore() {
      globalThis.wx = previousWx;
      delete require.cache[require.resolve(authPath)];
    },
  };
}

test("missing or unverified customer sessions are forced to the login flow", () => {
  for (const value of [undefined, session(false)]) {
    const host = loadAuth(value);
    try {
      assert.equal(host.auth.requireVerifiedCustomerAccess(), false);
      assert.deepEqual(host.redirects, [
        "/pages/phone-verification/index?required=1",
      ]);
    } finally {
      host.restore();
    }
  }
});

test("a verified customer session opens protected pages without redirecting", () => {
  const host = loadAuth(session(true));
  try {
    assert.equal(host.auth.requireVerifiedCustomerAccess(), true);
    assert.deepEqual(host.redirects, []);
  } finally {
    host.restore();
  }
});

test("every customer menu and deep feature page uses the same access guard", () => {
  const protectedFiles = [
    "custom-tab-bar/index.ts",
    "pages/services/index.ts",
    "pages/discover/index.ts",
    "pages/messages/index.ts",
    "pages/therapists/index.ts",
    "pages/therapist-detail/index.ts",
    "pages/orders/index.ts",
    "pages/profile/index.ts",
    "pages/coupons/index.ts",
    "pages/stored-value/index.ts",
    "pages/settings/index.ts",
    "pages/account-security/index.ts",
    "pages/addresses/index.ts",
    "pages/customer-records/index.ts",
    "pages/booking/index.ts",
    "pages/admin-login/index.ts",
    "pages/mfa-recovery/index.ts",
  ];
  for (const file of protectedFiles) {
    const source = readFileSync(
      new URL("../apps/miniapp/" + file, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /requireVerifiedCustomerAccess/,
      file + " must enforce verified customer access",
    );
  }
});

test("the public landing page stays visible but every action is login-gated", () => {
  const source = readFileSync(
    new URL("../apps/miniapp/pages/home/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /async onShow\(\)\s*\{\s*if \(!requireVerifiedCustomerAccess\(\)\)/,
  );
  for (const handler of [
    "chooseAddress",
    "bookNow",
    "openServices",
    "openTherapists",
    "openOrders",
    "retryServices",
    "bookService",
  ]) {
    assert.match(
      source,
      new RegExp(handler + "[\\s\\S]{0,180}requireVerifiedCustomerAccess"),
      handler + " must require login before navigation or an action",
    );
  }
});

test("login and agreement pages remain reachable before authentication", () => {
  for (const file of [
    "pages/phone-verification/index.ts",
    "pages/agreement/index.ts",
  ]) {
    const source = readFileSync(
      new URL("../apps/miniapp/" + file, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /requireVerifiedCustomerAccess/);
  }
});

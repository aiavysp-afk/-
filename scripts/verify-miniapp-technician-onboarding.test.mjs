import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
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

test("both onboarding URLs register the same anonymous one-way form without reading an account", () => {
  for (const route of ["technician-onboarding", "technician-application"]) {
    let registrations = 0;
    const dependencies = [];
    vm.runInNewContext(compile("pages/" + route + "/index.ts"), {
      exports: {},
      require(name) {
        dependencies.push(name);
        assert.equal(name, "../../utils/simple-technician-intake");
        return { registerSimpleTechnicianIntake: () => registrations++ };
      },
      wx: new Proxy(
        {},
        {
          get: () => {
            throw Error(
              "Entry aliases must not request an account or network data",
            );
          },
        },
      ),
    });
    assert.equal(registrations, 1);
    assert.deepEqual(dependencies, ["../../utils/simple-technician-intake"]);
    assert.match(
      source("pages/" + route + "/index.wxml"),
      /<include src="\.\.\/\.\.\/utils\/simple-technician-intake-form\.wxml"\s*\/>/,
    );
  }
});

test("the shared entry presents only name, phone and one certificate, without login or workbench controls", () => {
  const form = source("utils/simple-technician-intake-form.wxml");
  assert.match(form, /姓名/);
  assert.match(form, /手机号/);
  assert.match(form, /证书照片/);
  assert.match(form, /bindtap="submit"/);
  assert.doesNotMatch(
    form,
    /getPhoneNumber|bindgetphonenumber|pairingCode|inviteCode|open-type="getUserInfo"|bindtap="(?:login|register|authorizeWechat|advance|submitReview)"/,
  );
  assert.equal((form.match(/<input\b/g) ?? []).length, 2);
});

test("legacy login returns remain exact allowlisted links rather than arbitrary destinations", () => {
  const exports = {};
  vm.runInNewContext(compile("utils/login-return.ts"), {
    exports,
    require: () => ({ safeFriendPaymentReturnPath: () => "" }),
  });
  for (const path of [
    "/pages/technician-onboarding/index",
    "/pages/technician-workbench/index",
    "/pages/admin-login/index",
  ]) {
    assert.equal(exports.safeLoginReturnPath(path), path);
    assert.equal(exports.safeLoginReturnPath(encodeURIComponent(path)), path);
  }
  for (const path of [
    "https://evil.invalid",
    "//evil.invalid",
    "/pages/technician-workbench/index?user=other",
    "/pages/technician-photos/index",
    "%E0%A4%A",
  ]) {
    assert.equal(exports.safeLoginReturnPath(path), "");
  }
});

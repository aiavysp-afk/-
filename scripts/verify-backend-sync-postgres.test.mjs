import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("./verify-backend-sync-postgres.mjs", import.meta.url),
);
const refused = (url) => {
  const env = {
    ...process.env,
    DATABASE_URL:
      "postgresql://postgres:do-not-use@production.invalid:5432/production",
  };
  delete env.BACKEND_SYNC_TEST_DATABASE_URL;
  if (url !== undefined) env.BACKEND_SYNC_TEST_DATABASE_URL = url;
  const result = spawnSync(process.execPath, [script], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BACKEND_SYNC_POSTGRES_REFUSED/);
  assert.doesNotMatch(
    result.stderr,
    /do-not-use|real-password|Prisma|ECONN|production\.invalid/,
  );
};
test("backend sync verifier never falls back to production DATABASE_URL", () =>
  refused());
for (const [name, url] of [
  ["empty", ""],
  ["invalid", "not-a-url"],
  [
    "host",
    "postgresql://friend_pay_test:friend_pay_fixture_only@localhost:55432/friend_pay_tests",
  ],
  [
    "remote",
    "postgresql://friend_pay_test:friend_pay_fixture_only@production.invalid:55432/friend_pay_tests",
  ],
  [
    "port",
    "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:5432/friend_pay_tests",
  ],
  [
    "database",
    "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/production",
  ],
  [
    "password",
    "postgresql://friend_pay_test:real-password@127.0.0.1:55432/friend_pay_tests",
  ],
  [
    "user",
    "postgresql://other:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests",
  ],
  [
    "query",
    "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests?schema=public",
  ],
  [
    "fragment",
    "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests#fragment",
  ],
])
  test(`backend sync verifier refuses ${name} before loading Prisma`, () =>
    refused(url));

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("./verify-friend-pay-postgres.mjs", import.meta.url),
);
const refused = (url) => {
  const env = {
    ...process.env,
    DATABASE_URL:
      "postgresql://postgres:do-not-use@production.invalid:5432/production",
  };
  delete env.FRIEND_PAY_TEST_DATABASE_URL;
  if (url !== undefined) env.FRIEND_PAY_TEST_DATABASE_URL = url;
  const result = spawnSync(process.execPath, [script], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FRIEND_PAY_POSTGRES_REFUSED/);
  assert.doesNotMatch(
    result.stderr,
    /do-not-use|Prisma|ECONN|production\.invalid/,
  );
};

test("friend pay PostgreSQL verifier refuses production DATABASE_URL fallback", () =>
  refused());
for (const value of [
  "",
  "not-a-url",
  "postgresql://friend_pay_test:friend_pay_fixture_only@localhost:55432/friend_pay_tests",
  "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:5432/friend_pay_tests",
  "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/production",
  "postgresql://friend_pay_test:real-password@127.0.0.1:55432/friend_pay_tests",
  "postgresql://other:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests",
  "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests?schema=public",
  "postgresql://friend_pay_test:friend_pay_fixture_only@127.0.0.1:55432/friend_pay_tests#fragment",
]) {
  test(`friend pay PostgreSQL verifier refuses out-of-scope fixture URL ${value.length}`, () =>
    refused(value));
}

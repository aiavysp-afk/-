import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
let root, child, upstream, base, captured;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "zydj-private-preview-test-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<h1>Private test</h1>");
  await writeFile(join(root, "assets/app.js"), "export const fixture = true;");
  await writeFile(join(root, ".env"), "do-not-serve");
  upstream = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    captured = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(parts).toString(),
    };
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end('{"data":{"fixture":true}}');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["scripts/serve-private-preview.mjs"], {
    env: {
      ...process.env,
      PREVIEW_ROOT: root,
      PREVIEW_PORT: String(port),
      PREVIEW_API_PORT: String(upstream.address().port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Private server startup timeout")),
      8000,
    );
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(Error("Private server exited"));
    });
  });
});
after(async () => {
  child?.kill();
  await new Promise((r) => upstream?.close(r));
  if (root && root.startsWith(join(tmpdir(), "zydj-private-preview-test-")))
    await rm(root, { recursive: true, force: true });
});
test("private SPA and static files include safety headers", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /Private test/);
  assert.match(await (await fetch(base + "/assets/app.js")).text(), /fixture/);
});
test("dotfiles and missing files cannot be served", async () => {
  for (const path of [
    "/.env",
    "/%2eenv",
    "/assets/missing.js",
    "/%5cetc/passwd",
  ])
    assert.equal((await fetch(base + path)).status, 404);
});
test("foreign Host is refused before proxying", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(
      base + "/v1/health",
      { headers: { Host: "foreign.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});
test("API proxy forwards authorization and exact idempotency/body but no arbitrary upstream", async () => {
  const res = await fetch(base + "/v1/orders", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic",
      "Idempotency-Key": "synthetic-key",
    },
    body: '{"fixture":true}',
  });
  assert.equal(res.status, 200);
  assert.equal(captured.url, "/v1/orders");
  assert.equal(captured.headers.authorization, "Bearer synthetic");
  assert.equal(captured.headers["idempotency-key"], "synthetic-key");
  assert.equal(captured.body, '{"fixture":true}');
});
test("unsupported API writes and static POST are refused", async () => {
  assert.equal(
    (await fetch(base + "/v1/orders", { method: "DELETE" })).status,
    405,
  );
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
});
test("SPA subroutes work without exposing other extensions", async () => {
  assert.equal((await fetch(base + "/orders")).status, 200);
  assert.equal((await fetch(base + "/secrets.json")).status, 404);
});

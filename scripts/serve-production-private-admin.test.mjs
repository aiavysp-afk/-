import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createPrivateAdminServer, allowedAdminMethods, API_ORIGIN, ADMIN_PORT } from "./serve-production-private-admin.mjs";

let root, outside, server, port, calls = [], failure = null;
const profile = "/v1/admin/organizations/org-1/technicians/tech-1/profile";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "zydj-production-admin-test-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<h1>Private production fixture</h1>");
  await writeFile(join(root, "assets/app.js"), "export const fixture = true;");
  await writeFile(join(root, ".env"), "never-expose");
  outside = await mkdtemp(join(tmpdir(), "zydj-production-admin-outside-"));
  await writeFile(join(outside, "secret.js"), "never-expose");
  await symlink(outside, join(root, "escape"), "junction");
  server = await createPrivateAdminServer(root, { fetchApi: async (url, options) => {
    calls.push({ url, options });
    if (failure === "timeout") throw new Error("secret internal timeout detail");
    if (failure === "redirect") return new Response("secret redirect detail", { status: 302, headers: { Location: "https://evil.invalid" } });
    if (url.endsWith("/photos/photo-1")) return new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg", "Set-Cookie": "do-not-forward", "Access-Control-Allow-Origin": "*" } });
    return new Response('{"data":{"fixture":true}}', { headers: { "Content-Type": "application/json" } });
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (root?.startsWith(join(tmpdir(), "zydj-production-admin-test-"))) await rm(root, { recursive: true, force: true });
  if (outside?.startsWith(join(tmpdir(), "zydj-production-admin-outside-"))) await rm(outside, { recursive: true, force: true });
});
function send(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { Host: "admin.mtsc.top", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
}
test("production ports are fixed and separate from acceptance", () => {
  assert.equal(ADMIN_PORT, 3222); assert.equal(API_ORIGIN, "http://127.0.0.1:3220");
});
test("SPA supports private blob previews and safe static assets", async () => {
  const result = await send("/");
  assert.equal(result.status, 200); assert.match(result.body.toString(), /Private production/);
  assert.match(result.headers["content-security-policy"], /img-src 'self' data: blob: https:/);
  assert.match(result.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal((await send("/assets/app.js")).status, 200);
  assert.equal((await send("/technicians", { method: "HEAD" })).body.length, 0);
});
test("foreign hosts and foreign origins cannot proxy tokens", async () => {
  for (const Host of ["evil.invalid", "admin.mtsc.top.evil.invalid", "127.0.0.1:3212", "admin.mtsc.top:3222", "name@admin.mtsc.top"]) {
    assert.equal((await send("/v1/auth/me", { headers: { Host, Authorization: "Bearer synthetic" } })).status, 403);
  }
  const count = calls.length;
  for (const Origin of ["http://admin.mtsc.top", "https://evil.invalid", "https://admin.mtsc.top:3222", "null"]) {
    assert.equal((await send("/v1/auth/me", { headers: { Origin, Authorization: "Bearer synthetic" } })).status, 403);
  }
  assert.equal(calls.length, count);
});
test("all required exact management routes have narrowly allowed methods", () => {
  const cases = [
    ["/v1/auth/browser-login/config", ["GET"]], ["/v1/auth/browser-login/create", ["POST"]],
    ["/v1/auth/browser-login/poll", ["POST"]], ["/v1/auth/browser-login/claim", ["POST"]], ["/v1/auth/browser-login/cancel", ["POST"]],
    ["/v1/auth/me", ["GET"]], ["/v1/auth/logout", ["POST"]], ["/v1/auth/mfa", ["GET"]], ["/v1/auth/mfa/verify", ["POST"]],
    ["/v1/admin/audit-logs", ["GET"]], ["/v1/admin/scheduling/shifts", ["GET", "POST"]],
    ["/v1/admin/catalog/services", ["GET"]], ["/v1/admin/catalog/services/service-1/publish", ["POST"]],
    ["/v1/admin/organizations/org-1/dashboard", ["GET"]], ["/v1/admin/organizations/org-1/technicians", ["GET"]],
    [profile, ["GET", "PATCH"]], [profile + "/submit-review", ["POST"]], [profile + "/photos", ["POST"]], [profile + "/photos/photo-1", ["GET"]],
    ["/v1/admin/organizations/org-1/technician-invitations", ["GET", "POST"]], ["/v1/admin/organizations/org-1/technician-invitations/invite-1/revoke", ["POST"]],
    ["/v1/admin/organizations/org-1/customer-center/config", ["GET", "PATCH"]], ["/v1/admin/organizations/org-1/customer-center/summary", ["GET"]],
    ["/v1/admin/organizations/org-1/payments/pay-1/refunds", ["GET", "POST"]], ["/v1/admin/organizations/org-1/refunds/refund-1/approve", ["POST"]],
    ["/v1/admin/organizations/org-1/safety-duty-staff/user-1/contact", ["POST"]],
    ["/v1/admin/organizations/org-1/mfa-recovery-requests/request-1/reject", ["POST"]],
  ];
  for (const [path, methods] of cases) assert.deepEqual(allowedAdminMethods(path), methods, path);
});
test("customer, dev, pairing approval and unknown API endpoints never fall back to SPA", async () => {
  const count = calls.length;
  for (const path of ["/v1", "/v1/unknown", "/v1/admin", "/v1/admin/organizations/org-1/anything", "/v1/dev/organizations", "/v1/orders", "/v1/customer-center/wallet/recharges", "/v1/auth/wechat-miniapp", "/v1/auth/browser-login/approve", "/v1/auth/browser-login/inspect", profile + "/photos/photo-1/extra"]) {
    assert.equal((await send(path)).status, 404, path);
  }
  assert.equal(calls.length, count);
});
test("encoded separators, normalization tricks, files and dot paths are rejected", async () => {
  for (const path of ["/.env", "/%2eenv", "/assets/missing.js", "/secrets.json", "/escape/secret.js", "//evil.invalid/v1/auth/me", "/v1/admin/../auth/me", "/v1/%61uth/me", "/v1/admin%2Fcatalog/services", "/v1/admin%252Fcatalog/services", "/%5cetc/passwd", "/v1/admin/organizations/org%00/technicians", "/v1/auth/me?bad=%", "/v1/auth/me?bad=%QQ", "/v1/%QQ"]) {
    assert.equal((await send(path)).status, 404, path);
  }
});
test("GET request bodies are rejected, never dropped silently", async () => {
  const count = calls.length;
  assert.equal((await send("/v1/auth/me", { headers: { "Content-Length": "2", "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal(calls.length, count);
});
test("upstream timeout and redirects fail closed without leaking details", async () => {
  try {
    for (failure of ["timeout", "redirect"]) {
      const result = await send("/v1/auth/me");
      assert.equal(result.status, 502); assert.equal(result.body.length, 0);
      assert.equal(result.headers.location, undefined);
    }
  } finally { failure = null; }
});
test("empty JSON bodies omit content type and are not fabricated", async () => {
  assert.equal((await send("/v1/auth/me", { headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic" } })).status, 200);
  assert.equal(calls.at(-1).options.headers["Content-Type"], undefined);
  assert.equal(calls.at(-1).options.body, undefined);
  await send("/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "0" } });
  assert.equal(calls.at(-1).options.headers["Content-Type"], undefined);
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.at(-1).options.headers.Origin, undefined);
});
test("JSON writes preserve HTTPS Origin, authorization and idempotency without spoofing forwarded headers", async () => {
  const body = '{"publicName":""}';
  const result = await send(profile, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic", Origin: "https://admin.mtsc.top", "Idempotency-Key": "synthetic-key", "X-Forwarded-For": "evil", Cookie: "evil", "X-Forwarded-Proto": "https" }, body });
  assert.equal(result.status, 200);
  const sent = calls.at(-1);
  assert.equal(sent.url, API_ORIGIN + profile);
  assert.equal(sent.options.body.toString(), body);
  assert.deepEqual(sent.options.headers, { "Content-Type": "application/json", Origin: "https://admin.mtsc.top", Authorization: "Bearer synthetic", "Idempotency-Key": "synthetic-key" });
  assert.equal(sent.options.redirect, "error");
});
test("private photo binary and content type survive but upstream cookies and CORS do not", async () => {
  const result = await send(profile + "/photos/photo-1", { headers: { Authorization: "Bearer synthetic" } });
  assert.equal(result.status, 200); assert.equal(result.headers["content-type"], "image/jpeg");
  assert.deepEqual([...result.body], [255, 216, 255]);
  assert.equal(result.headers["set-cookie"], undefined); assert.equal(result.headers["access-control-allow-origin"], undefined);
});
test("unsupported methods and non-JSON uploads are rejected without API effects", async () => {
  const count = calls.length;
  for (const method of ["POST", "DELETE", "PUT", "OPTIONS", "HEAD"]) assert.equal((await send("/v1/auth/me", { method })).status, 405);
  assert.equal((await send("/", { method: "POST" })).status, 405);
  assert.equal((await send(profile + "/photos", { method: "POST", body: "plain text", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal(calls.length, count);
});
test("oversized declared or streamed request bodies are rejected", async () => {
  const count = calls.length;
  assert.equal((await send(profile + "/photos", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1048577" }, body: "x".repeat(1_048_577) })).status, 413);
  assert.equal((await send(profile + "/photos", { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }, body: "x".repeat(1_048_577) })).status, 413);
  assert.equal(calls.length, count);
});

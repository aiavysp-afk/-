import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  createPrivateAdminServer,
  allowedAdminMethods,
  API_ORIGIN,
  ADMIN_PORT,
  limitedTrustRequestCookie,
  permittedTrustResponseCookie,
} from "./serve-production-private-admin.mjs";

let root,
  outside,
  server,
  port,
  calls = [],
  failure = null;
const profile = "/v1/admin/organizations/org-1/technicians/tech-1/profile";
const identityDocument =
  "/v1/admin/organizations/org-1/technician-applications/tech-1/documents/ID_FRONT";
const walletLedger =
  "/v1/admin/organizations/org-1/customer-center/wallet-ledger";
const customerDirectory =
  "/v1/admin/organizations/org-1/customer-center/customers";
const customerPhoneReveal = customerDirectory + "/customer-1/reveal-phone";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "zydj-production-admin-test-"));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<h1>Private production fixture</h1>",
  );
  await writeFile(join(root, "assets/app.js"), "export const fixture = true;");
  await writeFile(join(root, ".env"), "never-expose");
  outside = await mkdtemp(join(tmpdir(), "zydj-production-admin-outside-"));
  await writeFile(join(outside, "secret.js"), "never-expose");
  await symlink(outside, join(root, "escape"), "junction");
  server = await createPrivateAdminServer(root, {
    fetchApi: async (url, options) => {
      calls.push({ url, options });
      if (failure === "timeout")
        throw new Error("secret internal timeout detail");
      if (failure === "redirect")
        return new Response("secret redirect detail", {
          status: 302,
          headers: { Location: "https://evil.invalid" },
        });
      if (failure === "trust-cookie")
        return new Response('{"data":{"trusted":true}}', {
          headers: { "Content-Type": "application/json", "Set-Cookie": `__Host-zydj_staff_trust=${"x".repeat(43)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict` },
        });
      if (
        new URL(url).pathname === walletLedger &&
        !options.headers.Authorization
      )
        return new Response('{"message":"Unauthorized"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      if ([customerDirectory, customerPhoneReveal].includes(new URL(url).pathname)) {
        const status = !options.headers.Authorization
          ? 401
          : options.headers.Authorization === "Bearer synthetic-denied"
            ? 403
            : 200;
        return new Response(
          status === 200
            ? '{"data":{"fixture":"customer-directory"}}'
            : JSON.stringify({ message: status === 401 ? "Unauthorized" : "Forbidden" }),
          {
            status,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "never-forward-private-customer-cookie",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      if (url.endsWith("/photos/photo-1"))
        return new Response(new Uint8Array([255, 216, 255]), {
          headers: {
            "Content-Type": "image/jpeg",
            "Set-Cookie": "do-not-forward",
            "Access-Control-Allow-Origin": "*",
          },
        });
      if (new URL(url).pathname === identityDocument)
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: {
            "Content-Type": "image/png",
            "Content-Disposition": "attachment; filename=private-id.png",
            "Set-Cookie": "do-not-forward",
            "Access-Control-Allow-Origin": "*",
          },
        });
      return new Response('{"data":{"fixture":true}}', {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (root?.startsWith(join(tmpdir(), "zydj-production-admin-test-")))
    await rm(root, { recursive: true, force: true });
  if (outside?.startsWith(join(tmpdir(), "zydj-production-admin-outside-")))
    await rm(outside, { recursive: true, force: true });
});
function send(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: "admin.mtsc.top", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("production ports are fixed and separate from acceptance", () => {
  assert.equal(ADMIN_PORT, 3222);
  assert.equal(API_ORIGIN, "http://127.0.0.1:3220");
});

test("new login and device routes are exact and method restricted", () => {
  assert.deepEqual(allowedAdminMethods("/v1/auth/staff-password"), ["GET", "PUT"]);
  assert.deepEqual(allowedAdminMethods("/v1/auth/staff-password/login"), ["POST"]);
  assert.deepEqual(allowedAdminMethods("/v1/auth/trusted-devices/accept"), ["POST"]);
  assert.deepEqual(allowedAdminMethods("/v1/auth/trusted-devices"), ["GET", "POST"]);
  for (const path of ["/v1/auth/staff-password/reset", "/v1/auth/trusted-devices/all", "/v1/auth/trusted-devices/accept/extra"]) assert.equal(allowedAdminMethods(path), undefined);
});

test("only one well-formed host device cookie is eligible for forwarding", () => {
  const token = "x".repeat(43);
  assert.equal(limitedTrustRequestCookie(`analytics=private; __Host-zydj_staff_trust=${token}`), `__Host-zydj_staff_trust=${token}`);
  assert.equal(limitedTrustRequestCookie(`__Host-zydj_staff_trust=${token}; __Host-zydj_staff_trust=${token}`), undefined);
  assert.equal(limitedTrustRequestCookie("__Host-zydj_staff_trust=bad"), undefined);
  const secure = `__Host-zydj_staff_trust=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`;
  assert.equal(permittedTrustResponseCookie(secure), true);
  for (const unsafe of [secure.replace("; Secure", ""), secure + "; Domain=mtsc.top", secure + "; Max-Age=999999", secure.replace("Strict", "None"), secure.replace("__Host-zydj_staff_trust", "other")]) assert.equal(permittedTrustResponseCookie(unsafe), false);
});

test("cookie relay is restricted to trusted-device routes without widening other headers", async () => {
  failure = "trust-cookie";
  try {
    const headers = { Cookie: `analytics=private; __Host-zydj_staff_trust=${"x".repeat(43)}`, "User-Agent": "synthetic-fixture-agent", "Content-Type": "application/json", Origin: "https://admin.mtsc.top" };
    const trusted = await send("/v1/auth/trusted-devices/accept", { method: "POST", headers, body: "{}" });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.headers["set-cookie"].length, 1);
    assert.equal(calls.at(-1).options.headers.Cookie, `__Host-zydj_staff_trust=${"x".repeat(43)}`);
    assert.equal(calls.at(-1).options.headers["User-Agent"], "synthetic-fixture-agent");
    const generic = await send("/v1/auth/mfa/verify", { method: "POST", headers, body: '{"code":"123456"}' });
    assert.equal(generic.headers["set-cookie"], undefined);
    assert.equal(calls.at(-1).options.headers.Cookie, undefined);
    assert.equal(calls.at(-1).options.headers["User-Agent"], undefined);
  } finally { failure = null; }
});
test("SPA supports private blob previews and safe static assets", async () => {
  const result = await send("/");
  assert.equal(result.status, 200);
  assert.match(result.body.toString(), /Private production/);
  assert.match(
    result.headers["content-security-policy"],
    /img-src 'self' data: blob: https:/,
  );
  assert.match(result.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal((await send("/assets/app.js")).status, 200);
  assert.equal((await send("/technicians", { method: "HEAD" })).body.length, 0);
});
test("foreign hosts and foreign origins cannot proxy tokens", async () => {
  for (const Host of [
    "evil.invalid",
    "admin.mtsc.top.evil.invalid",
    "127.0.0.1:3212",
    "admin.mtsc.top:3222",
    "name@admin.mtsc.top",
  ]) {
    assert.equal(
      (
        await send("/v1/auth/me", {
          headers: { Host, Authorization: "Bearer synthetic" },
        })
      ).status,
      403,
    );
  }
  const count = calls.length;
  for (const Origin of [
    "http://admin.mtsc.top",
    "https://evil.invalid",
    "https://admin.mtsc.top:3222",
    "null",
  ]) {
    assert.equal(
      (
        await send("/v1/auth/me", {
          headers: { Origin, Authorization: "Bearer synthetic" },
        })
      ).status,
      403,
    );
  }
  assert.equal(calls.length, count);
});
test("all required exact management routes have narrowly allowed methods", () => {
  const cases = [
    ["/v1/auth/browser-login/config", ["GET"]],
    ["/v1/auth/browser-login/create", ["POST"]],
    ["/v1/auth/browser-login/poll", ["POST"]],
    ["/v1/auth/browser-login/claim", ["POST"]],
    ["/v1/auth/browser-login/cancel", ["POST"]],
    ["/v1/auth/me", ["GET"]],
    ["/v1/auth/logout", ["POST"]],
    ["/v1/auth/mfa", ["GET"]],
    ["/v1/auth/mfa/verify", ["POST"]],
    ["/v1/admin/audit-logs", ["GET"]],
    ["/v1/admin/scheduling/shifts", ["GET", "POST"]],
    ["/v1/admin/catalog/services", ["GET"]],
    ["/v1/admin/catalog/services/service-1/publish", ["POST"]],
    ["/v1/admin/organizations/org-1/dashboard", ["GET"]],
    ["/v1/admin/organizations/org-1/technicians", ["GET"]],
    ["/v1/admin/organizations/org-1/technician-applications", ["GET"]],
    [identityDocument, ["GET"]],
    [
      "/v1/admin/organizations/org-1/technician-applications/tech-1/documents/ID_BACK",
      ["GET"],
    ],
    [profile, ["GET", "PATCH"]],
    [profile + "/submit-review", ["POST"]],
    [profile + "/reject", ["POST"]],
    [profile + "/photos", ["POST"]],
    [profile + "/photos/photo-1", ["GET"]],
    ["/v1/admin/organizations/org-1/technician-invitations", ["GET", "POST"]],
    [
      "/v1/admin/organizations/org-1/technician-invitations/invite-1/revoke",
      ["POST"],
    ],
    ["/v1/admin/organizations/org-1/customer-center/config", ["GET", "PATCH"]],
    ["/v1/admin/organizations/org-1/customer-center/summary", ["GET"]],
    [walletLedger, ["GET"]],
    [customerDirectory, ["GET"]],
    [customerPhoneReveal, ["POST"]],
    ["/v1/admin/organizations/org-1/payments/pay-1/refunds", ["GET", "POST"]],
    ["/v1/admin/organizations/org-1/refunds/refund-1/approve", ["POST"]],
    [
      "/v1/admin/organizations/org-1/safety-duty-staff/user-1/contact",
      ["POST"],
    ],
    [
      "/v1/admin/organizations/org-1/mfa-recovery-requests/request-1/reject",
      ["POST"],
    ],
  ];
  for (const [path, methods] of cases)
    assert.deepEqual(allowedAdminMethods(path), methods, path);
});
test("customer, dev, pairing approval and unknown API endpoints never fall back to SPA", async () => {
  const count = calls.length;
  for (const path of [
    "/v1",
    "/v1/unknown",
    "/v1/admin",
    "/v1/admin/organizations/org-1/anything",
    "/v1/dev/organizations",
    "/v1/orders",
    "/v1/customer-center/wallet/recharges",
    "/v1/auth/wechat-miniapp",
    "/v1/auth/browser-login/approve",
    "/v1/auth/browser-login/inspect",
    profile + "/photos/photo-1/extra",
    identityDocument + "/extra",
    identityDocument.replace("ID_FRONT", "PASSPORT"),
  ]) {
    assert.equal((await send(path)).status, 404, path);
  }
  assert.equal(calls.length, count);
});

test("wallet ledger forwards only an exact GET and preserves API authentication", async () => {
  const result = await send(walletLedger + "?limit=25&customerId=customer-1", {
    headers: {
      Authorization: "Bearer synthetic",
      Origin: "https://admin.mtsc.top",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(
    calls.at(-1).url,
    API_ORIGIN + walletLedger + "?limit=25&customerId=customer-1",
  );
  assert.deepEqual(calls.at(-1).options.headers, {
    Authorization: "Bearer synthetic",
    Origin: "https://admin.mtsc.top",
  });
  assert.equal((await send(walletLedger)).status, 401);
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
});

test("wallet ledger refuses non-GET and extra namespace suffixes without API effects", async () => {
  const count = calls.length;
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    assert.equal((await send(walletLedger, { method })).status, 405, method);
  }
  for (const path of [
    walletLedger + "/",
    walletLedger + "/extra",
    walletLedger + "-export",
    walletLedger.replace("/wallet-ledger", "/wallet-ledger-export"),
  ]) {
    assert.equal(allowedAdminMethods(path), undefined, path);
    assert.equal((await send(path)).status, 404, path);
  }
  assert.equal(calls.length, count);
});

test("customer directory forwards pagination and bearer authorization without cookies or invented MFA", async () => {
  const query = "?limit=20&cursor=customer_previous";
  const result = await send(customerDirectory + query, {
    headers: {
      Authorization: "Bearer synthetic",
      Origin: "https://admin.mtsc.top",
      Cookie: `analytics=private; __Host-zydj_staff_trust=${"x".repeat(43)}`,
      "X-MFA-Verified": "true",
      "X-Forwarded-For": "untrusted-fixture",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(calls.at(-1).url, API_ORIGIN + customerDirectory + query);
  assert.equal(calls.at(-1).options.method, "GET");
  assert.equal(calls.at(-1).options.body, undefined);
  assert.deepEqual(calls.at(-1).options.headers, {
    Origin: "https://admin.mtsc.top",
    Authorization: "Bearer synthetic",
  });
});

test("complete-phone POST preserves only the explicit reason, real Origin and authorization", async () => {
  const body = JSON.stringify({ reason: "核对预约服务资料" });
  const result = await send(customerPhoneReveal, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic",
      Origin: "https://admin.mtsc.top",
      Cookie: `analytics=private; __Host-zydj_staff_trust=${"x".repeat(43)}`,
      "X-MFA-Verified": "true",
      "X-Staff-Verified": "true",
      "X-Forwarded-For": "untrusted-fixture",
    },
    body,
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(calls.at(-1).url, API_ORIGIN + customerPhoneReveal);
  assert.equal(calls.at(-1).options.method, "POST");
  assert.equal(calls.at(-1).options.body.toString(), body);
  assert.deepEqual(calls.at(-1).options.headers, {
    "Content-Type": "application/json",
    Origin: "https://admin.mtsc.top",
    Authorization: "Bearer synthetic",
  });
  assert.equal(calls.at(-1).options.redirect, "error");
});

test("customer directory and reveal retain upstream anonymous 401 and authorization/MFA 403", async () => {
  for (const [path, method] of [[customerDirectory, "GET"], [customerPhoneReveal, "POST"]]) {
    for (const [Authorization, status, message] of [
      [undefined, 401, "Unauthorized"],
      ["Bearer synthetic-denied", 403, "Forbidden"],
    ]) {
      const result = await send(path, {
        method,
        headers: {
          Origin: "https://admin.mtsc.top",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(Authorization ? { Authorization } : {}),
          "X-MFA-Verified": "true",
        },
        ...(method === "POST" ? { body: JSON.stringify({ reason: "核对预约服务资料" }) } : {}),
      });
      assert.equal(result.status, status, `${method} ${path}`);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(result.body), { message });
      assert.equal(calls.at(-1).options.headers.Authorization, Authorization);
      assert.equal(calls.at(-1).options.headers["X-MFA-Verified"], undefined);
    }
  }
});

test("customer directory routes reject alternate methods, namespace expansion and encoded separators locally", async () => {
  const count = calls.length;
  for (const [path, permitted] of [[customerDirectory, "GET"], [customerPhoneReveal, "POST"]]) {
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"].filter((item) => item !== permitted)) {
      const result = await send(path, { method });
      assert.equal(result.status, 405, `${method} ${path}`);
      assert.equal(result.headers.allow, permitted);
    }
  }
  for (const path of [
    customerDirectory + "/",
    customerDirectory + "/export",
    customerDirectory + "-export",
    customerDirectory + "/customer-1",
    customerPhoneReveal + "/",
    customerPhoneReveal + "/extra",
    customerPhoneReveal + "-export",
    customerDirectory.replace("/org-1/", "/org%2F1/"),
    customerPhoneReveal.replace("/customer-1/", "/customer%2F1/"),
    customerPhoneReveal.replace("/customer-1/", "/customer%252F1/"),
    customerPhoneReveal.replace("/customer-1/", "/customer%5C1/"),
    customerDirectory.replace("/org-1/", "/org.1/"),
    customerDirectory.replace("/org-1/", "/org%00/"),
    "/v1/customer-center/customers",
    "/v1/admin/customer-center/customers",
    "/v1/admin/organizations/org-1/customers",
    "/v1/admin/organizations/org-1/customer-center/reveal-phone",
  ]) {
    assert.equal(allowedAdminMethods(path), undefined, path);
    assert.equal((await send(path)).status, 404, path);
  }
  assert.deepEqual(allowedAdminMethods("/v1/admin/organizations/org_A/customer-center/customers"), ["GET"]);
  assert.deepEqual(allowedAdminMethods("/v1/admin/organizations/org_A/customer-center/customers/customer_B/reveal-phone"), ["POST"]);
  assert.equal(calls.length, count);
});

test("foreign Origins cannot forward customer-directory reads or complete-phone requests", async () => {
  const count = calls.length;
  for (const [path, method] of [[customerDirectory, "GET"], [customerPhoneReveal, "POST"]]) {
    for (const Origin of ["https://evil.invalid", "http://admin.mtsc.top", "https://admin.mtsc.top.evil.invalid", "https://admin.mtsc.top:3222", "null"]) {
      const result = await send(path, {
        method,
        headers: {
          Origin,
          Authorization: "Bearer synthetic",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify({ reason: "核对预约服务资料" }) } : {}),
      });
      assert.equal(result.status, 403, `${method} ${Origin}`);
      assert.equal(result.body.length, 0);
    }
  }
  assert.equal(calls.length, count);
});
test("encoded separators, normalization tricks, files and dot paths are rejected", async () => {
  for (const path of [
    "/.env",
    "/%2eenv",
    "/assets/missing.js",
    "/secrets.json",
    "/escape/secret.js",
    "//evil.invalid/v1/auth/me",
    "/v1/admin/../auth/me",
    "/v1/%61uth/me",
    "/v1/admin%2Fcatalog/services",
    "/v1/admin%252Fcatalog/services",
    "/%5cetc/passwd",
    "/v1/admin/organizations/org%00/technicians",
    "/v1/auth/me?bad=%",
    "/v1/auth/me?bad=%QQ",
    "/v1/%QQ",
  ]) {
    assert.equal((await send(path)).status, 404, path);
  }
});
test("GET request bodies are rejected, never dropped silently", async () => {
  const count = calls.length;
  assert.equal(
    (
      await send("/v1/auth/me", {
        headers: { "Content-Length": "2", "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(calls.length, count);
});
test("upstream timeout and redirects fail closed without leaking details", async () => {
  try {
    for (failure of ["timeout", "redirect"]) {
      const result = await send("/v1/auth/me");
      assert.equal(result.status, 502);
      assert.equal(result.body.length, 0);
      assert.equal(result.headers.location, undefined);
    }
  } finally {
    failure = null;
  }
});
test("empty JSON bodies omit content type and are not fabricated", async () => {
  assert.equal(
    (
      await send("/v1/auth/me", {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer synthetic",
        },
      })
    ).status,
    200,
  );
  assert.equal(calls.at(-1).options.headers["Content-Type"], undefined);
  assert.equal(calls.at(-1).options.body, undefined);
  await send("/v1/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "0" },
  });
  assert.equal(calls.at(-1).options.headers["Content-Type"], undefined);
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.at(-1).options.headers.Origin, undefined);
});
test("JSON writes preserve HTTPS Origin, authorization and idempotency without spoofing forwarded headers", async () => {
  const body = '{"publicName":""}';
  const result = await send(profile, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic",
      Origin: "https://admin.mtsc.top",
      "Idempotency-Key": "synthetic-key",
      "X-Forwarded-For": "evil",
      Cookie: "evil",
      "X-Forwarded-Proto": "https",
    },
    body,
  });
  assert.equal(result.status, 200);
  const sent = calls.at(-1);
  assert.equal(sent.url, API_ORIGIN + profile);
  assert.equal(sent.options.body.toString(), body);
  assert.deepEqual(sent.options.headers, {
    "Content-Type": "application/json",
    Origin: "https://admin.mtsc.top",
    Authorization: "Bearer synthetic",
    "Idempotency-Key": "synthetic-key",
  });
  assert.equal(sent.options.redirect, "error");
});
test("private photo binary and content type survive but upstream cookies and CORS do not", async () => {
  const result = await send(profile + "/photos/photo-1", {
    headers: { Authorization: "Bearer synthetic" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "image/jpeg");
  assert.deepEqual([...result.body], [255, 216, 255]);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
});
test("private identity document binary is narrowly proxied without download, cookie or CORS headers", async () => {
  const result = await send(identityDocument, {
    headers: { Authorization: "Bearer synthetic" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "image/png");
  assert.deepEqual([...result.body], [137, 80, 78, 71]);
  assert.equal(result.headers["content-disposition"], undefined);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls.at(-1).url, API_ORIGIN + identityDocument);
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer synthetic");

  const count = calls.length;
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"])
    assert.equal(await send(identityDocument, { method }).then((item) => item.status), 405);
  assert.equal(calls.length, count);
});
test("unsupported methods and non-JSON uploads are rejected without API effects", async () => {
  const count = calls.length;
  for (const method of ["POST", "DELETE", "PUT", "OPTIONS", "HEAD"])
    assert.equal((await send("/v1/auth/me", { method })).status, 405);
  assert.equal((await send("/", { method: "POST" })).status, 405);
  assert.equal(
    (
      await send(profile + "/photos", {
        method: "POST",
        body: "plain text",
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(calls.length, count);
});
test("oversized declared or streamed request bodies are rejected", async () => {
  const count = calls.length;
  assert.equal(
    (
      await send(profile + "/photos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "1048577",
        },
        body: "x".repeat(1_048_577),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await send(profile + "/photos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
        body: "x".repeat(1_048_577),
      })
    ).status,
    413,
  );
  assert.equal(calls.length, count);
});

// Production management only: fixed loopback listener and production upstream.
// Authentication, fresh MFA, organization ownership and audit remain API duties.
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pathToFileURL } from "node:url";

export const ADMIN_PORT = 3222;
export const API_ORIGIN = "http://127.0.0.1:3220";
const bodyLimit = 1_048_576;
const segment = "[A-Za-z0-9_-]+";
const organization = `/v1/admin/organizations/${segment}`;
const rules = [
  [/^\/v1\/(?:health|catalog\/services)$/, ["GET"]],
  [/^\/v1\/auth\/me$/, ["GET"]],
  [/^\/v1\/auth\/logout$/, ["POST"]],
  [/^\/v1\/auth\/browser-login\/config$/, ["GET"]],
  [/^\/v1\/auth\/browser-login\/(?:create|poll|claim|cancel)$/, ["POST"]],
  [/^\/v1\/auth\/mfa$/, ["GET"]],
  [/^\/v1\/auth\/mfa\/(?:enrollment|activate|verify)$/, ["POST"]],
  [/^\/v1\/admin\/(?:audit-logs|catalog\/services)$/, ["GET"]],
  [new RegExp(`^/v1/admin/catalog/services/${segment}/(?:publish|unpublish)$`), ["POST"]],
  [/^\/v1\/admin\/scheduling\/shifts$/, ["GET", "POST"]],
  [new RegExp(`^${organization}/(?:dashboard|dispatch|technicians|service-area|readiness|payments|safety-duty-rosters/current|safety-duty-staff|safety-notifications|safety-notifications-summary|safety-incidents|mfa-recovery-requests)$`), ["GET"]],
  [new RegExp(`^${organization}/dispatch/orders/${segment}/assign$`), ["POST"]],
  [new RegExp(`^${organization}/payments/${segment}/refunds$`), ["GET", "POST"]],
  [new RegExp(`^${organization}/refunds/${segment}/(?:approve|reject|submit|reconcile)$`), ["POST"]],
  [new RegExp(`^${organization}/(?:safety-duty-rosters|safety-duty-staff/${segment}/contact|safety-notifications/${segment}/retry|safety-incidents/${segment}/(?:acknowledge|close))$`), ["POST"]],
  [new RegExp(`^${organization}/mfa-recovery-requests/${segment}/(?:approve|reject)$`), ["POST"]],
  [new RegExp(`^${organization}/technicians/${segment}/profile$`), ["GET", "PATCH"]],
  [new RegExp(`^${organization}/technicians/${segment}/profile/(?:submit-review|approve|publish|unpublish)$`), ["POST"]],
  [new RegExp(`^${organization}/technicians/${segment}/profile/photos$`), ["POST"]],
  [new RegExp(`^${organization}/technicians/${segment}/profile/photos/[A-Za-z0-9-]+$`), ["GET"]],
  [new RegExp(`^${organization}/technicians/${segment}/reviews$`), ["GET"]],
  [new RegExp(`^${organization}/technicians/${segment}/reviews/${segment}/(?:publish|hide)$`), ["POST"]],
  [new RegExp(`^${organization}/technician-invitations$`), ["GET", "POST"]],
  [new RegExp(`^${organization}/technician-invitations/${segment}/revoke$`), ["POST"]],
  [new RegExp(`^${organization}/customer-center/config$`), ["GET", "PATCH"]],
  [new RegExp(`^${organization}/customer-center/summary$`), ["GET"]],
];
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export function allowedAdminMethods(path) {
  return rules.find(([pattern]) => pattern.test(path))?.[1];
}

export async function createPrivateAdminServer(directory, { fetchApi = fetch } = {}) {
  const root = await realpath(directory);
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (!["127.0.0.1:3222", "localhost:3222", "admin.mtsc.top"].includes(req.headers.host ?? "")) {
        res.writeHead(403).end(); return;
      }
      const raw = req.url ?? "/";
      // Reject ambiguous/encoded separators before URL normalization can hide them.
      if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x20]/.test(raw) || /%(?:2f|5c|00|25)/i.test(raw.split("?")[0])) {
        res.writeHead(404).end(); return;
      }
      try { decodeURIComponent(raw); } catch { res.writeHead(404).end(); return; }
      const url = new URL(raw, "http://127.0.0.1:3222");
      const decoded = decodeURIComponent(raw.split("?")[0]);
      if (decoded !== url.pathname || decoded.split("/").some((part) => part.startsWith("."))) {
        res.writeHead(404).end(); return;
      }
      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
        const methods = allowedAdminMethods(url.pathname);
        if (!methods) { res.writeHead(404).end(); return; }
        if (!methods.includes(req.method ?? "")) { res.writeHead(405, { Allow: methods.join(", ") }).end(); return; }
        if (req.headers.origin && req.headers.origin !== "https://admin.mtsc.top") {
          res.writeHead(403).end(); return;
        }
        const declaredSize = Number(req.headers["content-length"] ?? 0);
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > bodyLimit) {
          res.writeHead(413).end(); return;
        }
        const parts = []; let size = 0;
        for await (const part of req) {
          size += part.length;
          if (size > bodyLimit) { res.writeHead(413).end(); return; }
          parts.push(part);
        }
        if (size && req.method === "GET") { res.writeHead(400).end(); return; }
        if (size && !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? "")) {
          res.writeHead(415).end(); return;
        }
        const headers = {
          ...(size ? { "Content-Type": "application/json" } : {}),
          ...(req.headers.origin ? { Origin: req.headers.origin } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          ...(req.headers["idempotency-key"] ? { "Idempotency-Key": req.headers["idempotency-key"] } : {}),
        };
        const response = await fetchApi(`${API_ORIGIN}${url.pathname}${url.search}`, {
          method: req.method, headers,
          ...(size ? { body: Buffer.concat(parts) } : {}),
          redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        if (response.status >= 300 && response.status < 400) throw Error("Upstream redirect refused");
        const bytes = Buffer.from(await response.arrayBuffer());
        // No redirects, cookies, permissive CORS, or arbitrary upstream headers.
        res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json" });
        res.end(bytes); return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      let file = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
      } catch {
        if (extname(url.pathname)) { res.writeHead(404).end(); return; }
        file = resolve(root, "index.html");
      }
      file = await realpath(file);
      if (!file.startsWith(root + sep) || !types[extname(file)]) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { "Content-Type": types[extname(file)] });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.NODE_ENV !== "production" || !process.env.PRIVATE_ADMIN_ROOT) {
    throw Error("Production mode and an explicit immutable admin root are required");
  }
  const server = await createPrivateAdminServer(process.env.PRIVATE_ADMIN_ROOT);
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(ADMIN_PORT, "127.0.0.1", () => console.log(`Production private admin on 127.0.0.1:${ADMIN_PORT}`));
}

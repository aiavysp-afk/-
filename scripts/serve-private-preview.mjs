// Private acceptance only. No public listener, credentials, or dynamic file execution.
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
const root = await realpath(process.env.PREVIEW_ROOT ?? "apps/admin-web/dist");
const port = Number(process.env.PREVIEW_PORT ?? 3212);
const apiPort = Number(process.env.PREVIEW_API_PORT ?? 3210);
if (
  ![port, apiPort].every((p) => Number.isInteger(p) && p > 1024 && p <= 65535)
)
  throw Error("Invalid private ports");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  try {
    const host = new URL(`http://${req.headers.host ?? ""}`).hostname;
    if (!["127.0.0.1", "localhost"].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/v1/")) {
      if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
        res.writeHead(405).end();
        return;
      }
      const parts = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 1_048_576) {
          res.writeHead(413).end();
          return;
        }
        parts.push(part);
      }
      const response = await fetch(
        `http://127.0.0.1:${apiPort}${url.pathname}${url.search}`,
        {
          method: req.method,
          headers: {
            "Content-Type": "application/json",
            ...(req.headers.origin ? { Origin: req.headers.origin } : {}),
            ...(req.headers.authorization
              ? { Authorization: req.headers.authorization }
              : {}),
            ...(req.headers["idempotency-key"]
              ? { "Idempotency-Key": req.headers["idempotency-key"] }
              : {}),
          },
          ...(req.method !== "GET" ? { body: Buffer.concat(parts) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(35_000),
        },
      );
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const decoded = decodeURIComponent(url.pathname);
    if (
      decoded.split("/").some((p) => p.startsWith(".") || p.includes("\\")) ||
      decoded.includes("\0")
    ) {
      res.writeHead(404).end();
      return;
    }
    let file = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
    } catch {
      if (extname(decoded)) {
        res.writeHead(404).end();
        return;
      }
      file = resolve(root, "index.html");
    }
    file = await realpath(file);
    if (!file.startsWith(root + sep) || !types[extname(file)]) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    res.writeHead(200, { "Content-Type": types[extname(file)] });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Private acceptance preview on 127.0.0.1:${port}`),
);

import { Writable } from "node:stream";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { safeRequestLog, safeTelemetryPath } from "./safe-request-log.js";

describe("safe request logging", () => {
  it.each([
    ["/v1/orders?token=secret#private", "/v1/orders"],
    ["/v1/friend-payments/secret", "/v1/friend-payments/[redacted]"],
    ["/v1/friend-payments/expired/payment-intent?secret=hidden", "/v1/friend-payments/[redacted]/payment-intent"],
    ["/v1/friend-payments/invalid/reconcile", "/v1/friend-payments/[redacted]/reconcile"],
    ["/v1/friend-payments/invalid/extra-sensitive-suffix", "/v1/friend-payments/[redacted]"],
    ["/v1/friend-payments/first-secret/friend-payments/second-secret", "/v1/friend-payments/[redacted]"],
    ["/v1/friend%2Dpayments/first-secret/friend%2Dpayments/second-secret", "/v1/friend-payments/[redacted]"],
    ["/v1/friend%2Dpayments/encoded-secret", "/v1/friend-payments/[redacted]"],
    ["/v1/FRIEND-PAYMENTS/secret", "/v1/FRIEND-PAYMENTS/[redacted]"],
    ["/v1/friend-payments/%broken", "[invalid-path]"],
  ])("redacts %s", (url, expected) => {
    expect(safeTelemetryPath(url)).toBe(expected);
  });

  it("has no headers or body in the serializer", () => {
    const request = { method: "POST", url: "/v1/orders?private=secret", headers: { authorization: "Bearer private" }, body: { phone: "private" } };
    expect(safeRequestLog(request)).toEqual({ method: "POST", url: "/v1/orders" });
  });

  it("automatic Fastify request logs never contain invitation credentials", async () => {
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const app = fastify({ logger: { stream, serializers: { req: safeRequestLog } } });
    app.get("/v1/friend-payments/:token", async () => ({ status: "PENDING" }));
    try {
      await app.inject({ method: "GET", url: "/v1/friend-payments/private-invitation?access_token=private-session", headers: { authorization: "Bearer private-session" } });
      expect(output).toContain("/v1/friend-payments/[redacted]");
      expect(output).not.toMatch(/private-invitation|private-session|access_token|authorization/);
    } finally { await app.close(); }
  });
});

import Fastify from "fastify";
import { expect, it } from "vitest";
import { REVERSE_PROXY_TRUST } from "./proxy.js";

it("uses the nearest untrusted client hop, not a forged left-most forwarded IP", async () => {
  const app = Fastify({ trustProxy: REVERSE_PROXY_TRUST });
  app.get("/", async (request) => ({ ip: request.ip }));
  try {
    for (const forged of ["192.0.2.1", "192.0.2.2"]) {
      const result = await app.inject({
        method: "GET",
        url: "/",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": `${forged}, 198.51.100.23` },
      });
      expect(result.json().ip).toBe("198.51.100.23");
    }
    const direct = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "198.51.100.23",
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    expect(direct.json().ip).toBe("198.51.100.23");
  } finally {
    await app.close();
  }
});

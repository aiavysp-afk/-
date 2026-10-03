import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../config/env.js";
import { AuthCryptoService } from "./auth-crypto.service.js";

const createCrypto = () =>
  new AuthCryptoService(
    new ConfigService({
      AUTH_SESSION_PEPPER: "test-session-pepper-with-at-least-32-characters",
      DATA_ENCRYPTION_KEY_BASE64:
        "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
    }) as ConfigService<AppEnv, true>,
  );

describe("AuthCryptoService", () => {
  it("encrypts identity values with authenticated encryption", () => {
    const crypto = createCrypto();
    const first = crypto.encrypt("openid-example");
    const second = crypto.encrypt("openid-example");

    expect(first).not.toBe(second);
    expect(crypto.decrypt(first)).toBe("openid-example");
    expect(crypto.decrypt(second)).toBe("openid-example");
  });

  it("creates random session tokens and deterministic server-side hashes", () => {
    const crypto = createCrypto();
    const first = crypto.createSessionToken();
    const second = crypto.createSessionToken();

    expect(first).not.toBe(second);
    expect(crypto.hashSessionToken(first)).toHaveLength(64);
    expect(crypto.hashSessionToken(first)).toBe(crypto.hashSessionToken(first));
  });
});

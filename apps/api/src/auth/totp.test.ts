import { describe, it, expect } from "vitest";
import {
  createTotpSecret,
  decodeSecret,
  encodeBase32,
  hotp,
  matchTotp,
} from "./totp.js";
const key = Buffer.from("12345678901234567890");
describe("RFC TOTP", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches RFC6238 SHA1 vector %i", (seconds, expected) => {
    expect(hotp(key, BigInt(Math.floor(Number(seconds) / 30)), 8)).toBe(
      expected,
    );
  });
  it("matches HOTP RFC4226 vectors", () => {
    expect(
      [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n].map((c) => hotp(key, c)),
    ).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ]);
  });
  it("generates independent 160-bit Base32 secrets", () => {
    const a = createTotpSecret(),
      b = createTotpSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeSecret(a)).toHaveLength(20);
    expect(decodeSecret(encodeBase32(key))).toEqual(key);
  });
  it("accepts bounded drift but rejects consumed and old counters", () => {
    const now = new Date(90_000),
      secret = encodeBase32(key);
    expect(matchTotp(secret, hotp(key, 2n), now, null)).toBe(2n);
    expect(matchTotp(secret, hotp(key, 3n), now, 3n)).toBeNull();
    expect(matchTotp(secret, hotp(key, 4n), now, 3n)).toBe(4n);
    expect(matchTotp(secret, hotp(key, 1n), now, null)).toBeNull();
  });
  it("rejects malformed codes and counters", () => {
    expect(matchTotp(encodeBase32(key), "12345", new Date(), null)).toBeNull();
    expect(() => decodeSecret("bad")).toThrow();
    expect(() => hotp(key, -1n)).toThrow();
    expect(() => hotp(key, 0x10000000000000000n)).toThrow();
  });
});

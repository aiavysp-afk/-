import { describe, expect, it } from "vitest";
import {
  DUMMY_STAFF_PASSWORD_HASH,
  hashStaffPassword,
  isStaffPasswordValid,
  PasswordHashCapacityError,
  verifyStaffPassword,
} from "./password-hash.js";

describe("bounded staff scrypt password hashing", () => {
  it("accepts 12-128 characters and rejects null bytes or oversized input", () => {
    expect(isStaffPasswordValid("a".repeat(12))).toBe(true);
    expect(isStaffPasswordValid("中".repeat(128))).toBe(true);
    expect(isStaffPasswordValid("a".repeat(11))).toBe(false);
    expect(isStaffPasswordValid("a".repeat(129))).toBe(false);
    expect(isStaffPasswordValid("strong-password\0")).toBe(false);
  });
  it("stores fixed-strength parameters and a random 16-byte salt, never plaintext", async () => {
    const password = "Example-long-password!";
    const first = await hashStaffPassword(password),
      second = await hashStaffPassword(password);
    expect(first).toMatch(
      /^scrypt\.v1\.32768\.8\.1\.[0-9a-f]{32}\.[0-9a-f]{64}$/,
    );
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyStaffPassword(password, first)).toBe(true);
    expect(await verifyStaffPassword("not-the-same-password", first)).toBe(
      false,
    );
  });
  it("rejects malformed or downgraded hash parameters and the unknown-account dummy", async () => {
    expect(
      await verifyStaffPassword(
        "Example-long-password!",
        "scrypt.v1.16384.8.1.invalid.invalid",
      ),
    ).toBe(false);
    expect(
      await verifyStaffPassword(
        "Example-long-password!",
        DUMMY_STAFF_PASSWORD_HASH,
      ),
    ).toBe(false);
  });
  it("caps concurrent memory-intensive derivations at four without an unbounded queue", async () => {
    const work = Array.from({ length: 4 }, () =>
      hashStaffPassword("Example-long-password!"),
    );
    await expect(
      hashStaffPassword("Example-long-password!"),
    ).rejects.toBeInstanceOf(PasswordHashCapacityError);
    await Promise.all(work);
    await expect(hashStaffPassword("Example-long-password!")).resolves.toMatch(
      /^scrypt/,
    );
  });
});

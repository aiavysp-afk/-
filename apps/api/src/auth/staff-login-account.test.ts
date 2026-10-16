import { describe, expect, it } from "vitest";
import {
  normalizeStaffLoginAccount,
  normalizeStaffLoginAlias,
} from "./staff-login-account.js";

describe("staff login alias normalization", () => {
  it.each(["admin", " ADMIN ", "staff-ops_1", "a___", "a".repeat(32)])(
    "normalizes the valid ASCII alias %s",
    (value) => {
      expect(normalizeStaffLoginAlias(value)).toBe(value.trim().toLowerCase());
      expect(normalizeStaffLoginAccount(value)).toEqual({
        kind: "alias",
        value: value.trim().toLowerCase(),
      });
    },
  );
  it.each([
    "",
    " ",
    "abc",
    "a".repeat(33),
    "1admin",
    "13800001234",
    "staff.name",
    "admin@example.com",
    "管理员",
    "Ａdmin",
    "a\0bcd",
    "has space",
  ])(
    "rejects an invalid alias without treating it as another user's phone %s",
    (value) => {
      expect(normalizeStaffLoginAlias(value)).toBeNull();
    },
  );
  it("keeps existing phone accounts separate from aliases", () => {
    expect(normalizeStaffLoginAccount(" 13800001234 ")).toEqual({
      kind: "phone",
      value: "13800001234",
    });
    expect(normalizeStaffLoginAccount("12800001234")).toBeNull();
    expect(normalizeStaffLoginAccount("13800001234-extra")).toBeNull();
    expect(normalizeStaffLoginAccount("+8613800001234")).toBeNull();
  });
});

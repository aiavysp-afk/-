import { describe, expect, it } from "vitest";
import { TechnicianInvitationCreateSchema, TechnicianPhotoUploadSchema, TechnicianProfileUpdateSchema } from "./index.js";

describe("photo-first optional technician presentation", () => {
  it("allows blank name and no age in invitations and profile edits", () => {
    expect(TechnicianInvitationCreateSchema.parse({})).toMatchObject({ publicName: "" });
    expect(TechnicianProfileUpdateSchema.parse({ publicName: "", ageRange: null })).toEqual({ publicName: "", ageRange: null });
    expect(TechnicianProfileUpdateSchema.parse({ ageRange: "18-23岁" })).toEqual({ ageRange: "18-23岁" });
    expect(TechnicianProfileUpdateSchema.safeParse({ ageRange: "16岁" }).success).toBe(false);
  });

  it("requires explicit portrait authorization and bounded base64 data", () => {
    expect(TechnicianPhotoUploadSchema.safeParse({ kind: "AVATAR", base64: "AAAA", authorized: true }).success).toBe(true);
    for (const payload of [{ kind: "AVATAR", base64: "AAAA", authorized: false }, { kind: "CERTIFICATE", base64: "AAAA", authorized: true }, { kind: "AVATAR", base64: "A".repeat(699_053), authorized: true }, { kind: "AVATAR", base64: "AAAA", authorized: true, technicianId: "someone-else" }]) {
      expect(TechnicianPhotoUploadSchema.safeParse(payload).success).toBe(false);
    }
  });
});

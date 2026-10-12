import { describe, expect, it } from "vitest";
import {
  TechnicianH5ProfileUpdateSchema,
  TechnicianIdentityDocumentUploadSchema,
  TechnicianProfileSchema,
} from "./index.js";

const validProfile = {
  realName: "张三",
  serviceCity: "郑州市",
  serviceAreas: ["金水区", "中原区"],
  availableTimeSlots: ["MON:09:00-18:00", "SAT:10:00-20:00"],
  bio: "专注肩颈放松与经络调理多年。",
  serviceIds: ["service-1", "service-2"],
};

describe("技师H5入驻合同", () => {
  it("验证完整资料与规范化接单时段", () => {
    expect(TechnicianH5ProfileUpdateSchema.parse(validProfile)).toEqual(
      validProfile,
    );
    for (const availableTimeSlots of [
      ["MON:18:00-09:00"],
      ["MON 09:00-18:00"],
      ["MON:09:00-18:00", "MON:09:00-18:00"],
    ]) {
      expect(
        TechnicianH5ProfileUpdateSchema.safeParse({
          ...validProfile,
          availableTimeSlots,
        }).success,
      ).toBe(false);
    }
  });

  it("证件照只允许正反面和512KB以内的base64", () => {
    expect(
      TechnicianIdentityDocumentUploadSchema.safeParse({
        kind: "ID_FRONT",
        contentBase64: "AAAA",
      }).success,
    ).toBe(true);
    for (const value of [
      { kind: "PASSPORT", contentBase64: "AAAA" },
      { kind: "ID_BACK", contentBase64: "<svg/>" },
      { kind: "ID_FRONT", contentBase64: "A".repeat(699_053) },
    ]) {
      expect(TechnicianIdentityDocumentUploadSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("公开技师资料合同不接受真实姓名或证件字段", () => {
    const publicProfile = {
      technicianId: "technician",
      displayName: "小美",
      publicName: "小美",
      avatarUrl: null,
      galleryUrls: [],
      introduction: "",
      specialties: [],
      serviceYears: null,
      certificates: [],
      reviewSummary: {
        averageRating: null,
        reviewCount: 0,
        completedOrders: 0,
      },
      recentReviews: [],
      status: "DRAFT",
      rejectionReason: null,
      freeTravelFee: true,
      travelFeeFen: 0,
      updatedAt: new Date().toISOString(),
    };
    expect(
      TechnicianProfileSchema.safeParse({ ...publicProfile, realName: "张三" })
        .success,
    ).toBe(true);
    const parsed = TechnicianProfileSchema.parse({
      ...publicProfile,
      realName: "张三",
    });
    expect(parsed).not.toHaveProperty("realName");
    expect(parsed).not.toHaveProperty("identityDocuments");
  });
});

import { describe, expect, it } from "vitest";
import {
  profileDraftFrom,
  splitProfileList,
  technicianWorkbenchProfilePaths,
  type TechnicianProfile,
} from "./technician-profile";

describe("technician profile helpers", () => {
  it("builds the exact workbench profile endpoints", () => {
    expect(technicianWorkbenchProfilePaths()).toEqual({
      profile: "/technician/workbench/profile",
      submitReview: "/technician/workbench/profile/submit-review",
    });
  });

  it("normalizes comma and newline lists without inventing profile values", () => {
    expect(splitProfileList("肩颈放松，足部舒缓\n肩颈放松,  ")).toEqual([
      "肩颈放松",
      "足部舒缓",
    ]);
  });

  it("keeps only editable public fields in a draft", () => {
    const profile: TechnicianProfile = {
      technicianId: "tech-1",
      displayName: "实名账号",
      publicName: "公开称呼",
      avatarUrl: null,
      galleryUrls: [],
      introduction: "真实简介",
      specialties: ["肩颈放松"],
      serviceYears: 2,
      certificates: ["健康证明已核验"],
      reviewSummary: { averageRating: 5, reviewCount: 1, completedOrders: 1 },
      recentReviews: [],
      status: "PUBLISHED",
      rejectionReason: null,
      freeTravelFee: true,
      travelFeeFen: 0,
      updatedAt: "2026-10-08T00:00:00.000Z",
    };

    expect(profileDraftFrom(profile)).toEqual({
      publicName: "公开称呼",
      avatarUrl: null,
      galleryUrls: [],
      introduction: "真实简介",
      specialties: ["肩颈放松"],
      serviceYears: 2,
      certificates: ["健康证明已核验"],
    });
  });
});

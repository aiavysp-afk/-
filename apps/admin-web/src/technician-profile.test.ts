import { describe, expect, it, vi } from "vitest";
import type { TechnicianProfile } from "@zydj/contracts";
import {
  adminTechnicianProfilePaths,
  profileStatusLabels,
  reviewAvailableActions,
  reviewStatusLabels,
  splitProfileList,
  profileHasUnsavedChanges,
  profileUpdateFrom,
  submitLatestProfile,
  draftWithUploadedPhoto,
} from "./technician-profile";

const profile: TechnicianProfile = {
  technicianId: "tech-1",
  displayName: "实名账号",
  publicName: "公开称呼",
  avatarUrl: null,
  galleryUrls: [],
  introduction: "真实简介",
  specialties: ["肩颈放松"],
  serviceYears: 2,
  certificates: [],
  reviewSummary: { averageRating: 5, reviewCount: 1, completedOrders: 1 },
  recentReviews: [],
  status: "DRAFT",
  rejectionReason: null,
  freeTravelFee: true,
  travelFeeFen: 0,
  updatedAt: "2026-10-10T00:00:00.000Z",
};

describe("admin technician profile helpers", () => {
  it("keeps unsaved profile and gallery edits when another photo finishes uploading", () => {
    const draft = {
      ...profileUpdateFrom(profile),
      publicName: "最新称呼",
      galleryUrls: ["https://example.com/kept.jpg"],
    };
    const uploaded = draftWithUploadedPhoto(
      draft,
      "GALLERY",
      "https://example.com/new.jpg",
    );
    expect(uploaded.publicName).toBe("最新称呼");
    expect(uploaded.galleryUrls).toEqual([
      "https://example.com/kept.jpg",
      "https://example.com/new.jpg",
    ]);
    expect(
      draftWithUploadedPhoto(uploaded, "GALLERY", "https://example.com/new.jpg")
        .galleryUrls,
    ).toHaveLength(2);
  });
  it("detects unsaved text and photos without treating optional age as a change", () => {
    const draft = profileUpdateFrom(profile);
    expect(
      profileHasUnsavedChanges(profile, { ...draft, ageRange: null }),
    ).toBe(false);
    expect(
      profileHasUnsavedChanges(profile, {
        ...draft,
        introduction: "新的服务说明",
      }),
    ).toBe(true);
    expect(
      profileHasUnsavedChanges(profile, {
        ...draft,
        galleryUrls: ["https://example.com/photo.jpg"],
      }),
    ).toBe(true);
  });

  it("saves the latest draft before submitting its review", async () => {
    const draft = { ...profileUpdateFrom(profile), publicName: "最新称呼" };
    const calls: string[] = [];
    const saved = { ...profile, publicName: draft.publicName };
    const submitted = { ...saved, status: "PENDING_REVIEW" as const };
    const result = await submitLatestProfile(
      draft,
      async (value) => {
        expect(value.publicName).toBe("最新称呼");
        calls.push("save");
        return saved;
      },
      async () => {
        calls.push("submit");
        return submitted;
      },
      () => true,
    );
    expect(calls).toEqual(["save", "submit"]);
    expect(result).toBe(submitted);
  });

  it("does not submit when saving failed or the technician context changed", async () => {
    const submit = vi.fn().mockResolvedValue(profile);
    await expect(
      submitLatestProfile(
        profileUpdateFrom(profile),
        async () => {
          throw new Error("保存失败");
        },
        submit,
        () => true,
      ),
    ).rejects.toThrow("保存失败");
    expect(submit).not.toHaveBeenCalled();
    expect(
      await submitLatestProfile(
        profileUpdateFrom(profile),
        async () => profile,
        submit,
        () => false,
      ),
    ).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  it("builds the exact profile and UGC moderation endpoints", () => {
    const paths = adminTechnicianProfilePaths("org-1", "tech-1");

    expect(paths.profile).toBe(
      "/admin/organizations/org-1/technicians/tech-1/profile",
    );
    expect(paths.reviews).toBe(
      "/admin/organizations/org-1/technicians/tech-1/reviews",
    );
    expect(paths.profileAction("approve")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/profile/approve",
    );
    expect(paths.profileAction("submit-review")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/profile/submit-review",
    );
    expect(paths.profileAction("publish")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/profile/publish",
    );
    expect(paths.profileAction("unpublish")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/profile/unpublish",
    );
    expect(paths.reviewAction("review-1", "publish")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/reviews/review-1/publish",
    );
    expect(paths.reviewAction("review-1", "hide")).toBe(
      "/admin/organizations/org-1/technicians/tech-1/reviews/review-1/hide",
    );
  });

  it("deduplicates administrator-edited public labels", () => {
    expect(splitProfileList("肩颈放松\n肩颈放松，足部舒缓")).toEqual([
      "肩颈放松",
      "足部舒缓",
    ]);
  });

  it("keeps review and publication states visibly distinct", () => {
    expect(profileStatusLabels.PENDING_REVIEW).toBe("待审核");
    expect(profileStatusLabels.APPROVED).toBe("审核通过");
    expect(profileStatusLabels.PUBLISHED).toBe("已公开");
  });

  it("allows UGC moderation without an edit action", () => {
    expect(reviewStatusLabels.PENDING_REVIEW).toBe("待审核");
    expect(reviewAvailableActions("PENDING_REVIEW")).toEqual([
      "publish",
      "hide",
    ]);
    expect(reviewAvailableActions("PUBLISHED")).toEqual(["hide"]);
    expect(reviewAvailableActions("HIDDEN")).toEqual(["publish"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  adminTechnicianProfilePaths,
  profileStatusLabels,
  reviewAvailableActions,
  reviewStatusLabels,
  splitProfileList,
} from "./technician-profile";

describe("admin technician profile helpers", () => {
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

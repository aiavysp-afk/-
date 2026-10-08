import type {
  AdminTechnicianReview,
  TechnicianProfile,
  TechnicianProfileStatus,
  TechnicianProfileUpdate,
} from "@zydj/contracts";

type AdminReviewStatus = AdminTechnicianReview["status"];
type AdminProfileAction = "approve" | "publish" | "unpublish";
type AdminReviewAction = "publish" | "hide";

export function adminTechnicianProfilePaths(
  organizationId: string,
  technicianId: string,
) {
  const technicianPath = `/admin/organizations/${encodeURIComponent(organizationId)}/technicians/${encodeURIComponent(technicianId)}`;
  const profile = `${technicianPath}/profile`;
  const reviews = `${technicianPath}/reviews`;
  return {
    profile,
    reviews,
    profileAction: (action: AdminProfileAction) => `${profile}/${action}`,
    reviewAction: (reviewId: string, action: AdminReviewAction) =>
      `${reviews}/${encodeURIComponent(reviewId)}/${action}`,
  };
}

export const profileStatusLabels: Record<TechnicianProfileStatus, string> = {
  DRAFT: "技师草稿",
  PENDING_REVIEW: "待审核",
  APPROVED: "审核通过",
  PUBLISHED: "已公开",
  REJECTED: "已退回",
};

export const reviewStatusLabels: Record<AdminReviewStatus, string> = {
  PENDING_REVIEW: "待审核",
  PUBLISHED: "已公开",
  HIDDEN: "已隐藏",
};

export function reviewAvailableActions(status: AdminReviewStatus) {
  return status === "PENDING_REVIEW"
    ? (["publish", "hide"] as const)
    : status === "PUBLISHED"
      ? (["hide"] as const)
      : (["publish"] as const);
}

export function splitProfileList(value: string) {
  return [
    ...new Set(
      value
        .split(/[，,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function profileUpdateFrom(
  profile: TechnicianProfile,
): TechnicianProfileUpdate {
  return {
    publicName: profile.publicName,
    avatarUrl: profile.avatarUrl,
    galleryUrls: profile.galleryUrls,
    introduction: profile.introduction,
    specialties: profile.specialties,
    serviceYears: profile.serviceYears,
    certificates: profile.certificates,
  };
}

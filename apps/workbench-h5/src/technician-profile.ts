import type {
  TechnicianProfile,
  TechnicianProfileStatus,
  TechnicianProfileUpdate,
} from "@zydj/contracts";

export type TechnicianProfileDraft = TechnicianProfileUpdate;

export function technicianWorkbenchProfilePaths() {
  const profile = "/technician/workbench/profile";
  return {
    profile,
    submitReview: `${profile}/submit-review`,
  } as const;
}

export const profileStatusLabels: Record<TechnicianProfileStatus, string> = {
  DRAFT: "草稿",
  PENDING_REVIEW: "待后台审核",
  APPROVED: "审核通过，待发布",
  PUBLISHED: "已公开",
  REJECTED: "已退回修改",
};

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

export function profileDraftFrom(
  profile: TechnicianProfile,
): TechnicianProfileDraft {
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

export type { TechnicianProfile };

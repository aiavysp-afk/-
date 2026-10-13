import type { TechnicianApplication, TechnicianProfile } from "@zydj/contracts";

export function displayedTechnicianReviewVersion(
  profile: TechnicianProfile,
  application?: TechnicianApplication,
) {
  // Pin review to the private application actually visible to the reviewer.
  return application ? application.version : profile.version;
}

export function technicianReviewSnapshotMatches(
  profile: TechnicianProfile | null,
  application?: TechnicianApplication,
) {
  if (!profile) return false;
  if (!application) return true;
  return (
    typeof application.version === "number" &&
    application.version === profile.version &&
    application.technicianId === profile.technicianId &&
    application.status === profile.status
  );
}

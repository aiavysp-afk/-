import { describe, expect, it } from "vitest";
import type { TechnicianApplication, TechnicianProfile } from "@zydj/contracts";
import {
  displayedTechnicianReviewVersion,
  technicianReviewSnapshotMatches,
} from "./technician-review-snapshot";

const profile = {
  technicianId: "applicant-a",
  status: "PENDING_REVIEW",
  version: 8,
} as TechnicianProfile;
const application = {
  ...profile,
  registrationChannel: "WECHAT_MINIAPP",
} as TechnicianApplication;

describe("displayed technician private-review snapshot", () => {
  it("pins expectedVersion to the private application actually displayed, not a newer public-profile read", () => {
    const oldApplication = { ...application, version: 6 };
    expect(displayedTechnicianReviewVersion(profile, oldApplication)).toBe(6);
    expect(technicianReviewSnapshotMatches(profile, oldApplication)).toBe(
      false,
    );
  });

  it("allows review only when displayed application and profile revisions agree", () => {
    expect(technicianReviewSnapshotMatches(profile, application)).toBe(true);
    expect(displayedTechnicianReviewVersion(profile, application)).toBe(8);
    expect(
      technicianReviewSnapshotMatches(profile, { ...application, version: 9 }),
    ).toBe(false);
  });

  it("rejects a private application whose version is missing even if both reads omit it", () => {
    const versionlessProfile = { ...profile, version: undefined };
    const versionlessApplication = { ...application, version: undefined };
    expect(
      technicianReviewSnapshotMatches(
        versionlessProfile,
        versionlessApplication,
      ),
    ).toBe(false);
    expect(
      displayedTechnicianReviewVersion(profile, versionlessApplication),
    ).toBeUndefined();
  });

  it("does not reuse another technician's private snapshot", () => {
    expect(
      technicianReviewSnapshotMatches(profile, {
        ...application,
        technicianId: "applicant-b",
      }),
    ).toBe(false);
  });

  it("does not accept contradictory status snapshots", () => {
    expect(
      technicianReviewSnapshotMatches(profile, {
        ...application,
        status: "REJECTED",
      }),
    ).toBe(false);
  });

  it("preserves existing non-application profiles without inventing a revision", () => {
    expect(technicianReviewSnapshotMatches(null, application)).toBe(false);
    expect(technicianReviewSnapshotMatches(profile)).toBe(true);
    expect(displayedTechnicianReviewVersion(profile)).toBe(8);
    expect(
      displayedTechnicianReviewVersion({ ...profile, version: undefined }),
    ).toBeUndefined();
  });
});

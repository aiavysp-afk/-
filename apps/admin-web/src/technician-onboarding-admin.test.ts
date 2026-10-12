import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminIdentityDocumentPath,
  formatAvailabilityTimeSlot,
  hasIdentityDocument,
  loadPrivateIdentityDocumentPreview,
  maskRealName,
  onboardingServiceLabels,
  type TechnicianOnboardingReviewProfile,
} from "./technician-onboarding-admin";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin H5 onboarding review helpers", () => {
  it("masks real names outside the detail review", () => {
    expect(maskRealName(" ")).toBe("");
    expect(maskRealName("李雪")).toBe("李*");
    expect(maskRealName("王晓布")).toBe("王*布");
    expect(maskRealName("欧阳小雪")).toBe("欧**雪");
  });

  it("resolves selected service ids without hiding an unknown submitted value", () => {
    expect(
      onboardingServiceLabels(["svc-1", "legacy"], [
        {
          id: "svc-1",
          slug: "service-one",
          name: "中式推拿",
          category: "MASSAGE",
          subtitle: "日常放松",
          description: "测试项目说明",
          durationMinutes: 60,
          priceFen: 21_800,
          featured: true,
          steps: [],
          boundaries: [],
        },
      ]),
    ).toEqual(["中式推拿", "legacy"]);
  });

  it("renders submitted machine time slots for Chinese reviewers", () => {
    expect(formatAvailabilityTimeSlot("MON:09:00-18:00")).toBe(
      "周一 09:00-18:00",
    );
    expect(formatAvailabilityTimeSlot("legacy-slot")).toBe("legacy-slot");
  });

  it("uses explicit private-document presence flags", () => {
    const profile = {
      identityDocuments: {
        idFrontUploaded: true,
        idBackUploaded: false,
      },
    } as TechnicianOnboardingReviewProfile;
    expect(hasIdentityDocument(profile, "ID_FRONT")).toBe(true);
    expect(hasIdentityDocument(profile, "ID_BACK")).toBe(false);
  });

  it("builds a fixed organization-scoped path and loads the image on demand", async () => {
    const fetchDocument = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "Content-Type": "image/jpeg; charset=binary" },
      }),
    );
    vi.stubGlobal("fetch", fetchDocument);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-id");

    expect(adminIdentityDocumentPath("org/1", "tech?1", "ID_FRONT")).toBe(
      "/admin/organizations/org%2F1/technician-applications/tech%3F1/documents/ID_FRONT",
    );
    await expect(
      loadPrivateIdentityDocumentPreview(
        "/v1",
        "org-1",
        "tech-1",
        "ID_BACK",
        "admin-token",
      ),
    ).resolves.toBe("blob:private-id");
    expect(fetchDocument).toHaveBeenCalledWith(
      "/v1/admin/organizations/org-1/technician-applications/tech-1/documents/ID_BACK",
      {
        credentials: "omit",
        redirect: "error",
        headers: { Authorization: "Bearer admin-token" },
      },
    );
  });

  it("rejects ambiguous API bases, denied reads and non-images", async () => {
    const fetchDocument = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("<html></html>", {
          headers: { "Content-Type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchDocument);
    const create = vi.spyOn(URL, "createObjectURL");

    await expect(
      loadPrivateIdentityDocumentPreview(
        "//evil.invalid/v1",
        "org-1",
        "tech-1",
        "ID_FRONT",
        "admin-token",
      ),
    ).rejects.toThrow("证件接口配置无效");
    expect(fetchDocument).not.toHaveBeenCalled();

    await expect(
      loadPrivateIdentityDocumentPreview(
        "/v1",
        "org-1",
        "tech-1",
        "ID_FRONT",
        "admin-token",
      ),
    ).rejects.toThrow("无权查看");
    await expect(
      loadPrivateIdentityDocumentPreview(
        "/v1",
        "org-1",
        "tech-1",
        "ID_FRONT",
        "admin-token",
      ),
    ).rejects.toThrow("证件预览格式无效");
    expect(create).not.toHaveBeenCalled();
  });
});

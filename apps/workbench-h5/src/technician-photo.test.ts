import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTechnicianPhotoPreview } from "./technician-photo";

const adminPath = "/admin/organizations/org-1/technicians/tech-1/profile";
const ownerPath = "/technician/workbench/profile";
const productionPhoto = "https://api.mtsc.top/v1/technicians/tech-1/photos/photo-1";
const imageResponse = () => new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg" } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("private technician photo previews", () => {
  it("maps production public photos through the relative same-origin admin API", async () => {
    const fetchPhoto = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal("fetch", fetchPhoto);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    expect(await loadTechnicianPhotoPreview(productionPhoto, "/v1", adminPath, "synthetic-token")).toBe("blob:fixture");
    expect(fetchPhoto).toHaveBeenCalledOnce();
    expect(fetchPhoto).toHaveBeenCalledWith("/v1/admin/organizations/org-1/technicians/tech-1/profile/photos/photo-1", {
      credentials: "omit", redirect: "error", headers: { Authorization: "Bearer synthetic-token" },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps absolute configured API and relative owner preview compatibility", async () => {
    const fetchPhoto = vi.fn().mockImplementation(async () => imageResponse());
    vi.stubGlobal("fetch", fetchPhoto);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
    await loadTechnicianPhotoPreview("https://api.fixture.invalid/v1/technicians/tech-1/photos/photo-1", "https://api.fixture.invalid/v1/", adminPath, "synthetic-token");
    expect(fetchPhoto.mock.calls[0]?.[0]).toBe("https://api.fixture.invalid/v1/admin/organizations/org-1/technicians/tech-1/profile/photos/photo-1");
    await loadTechnicianPhotoPreview(productionPhoto, "/v1", ownerPath, "synthetic-token");
    expect(fetchPhoto.mock.calls[1]?.[0]).toBe("/v1/technician/workbench/profile/photos/photo-1");
  });

  it("never forwards credentials to a CDN or a lookalike foreign origin", async () => {
    const fetchPhoto = vi.fn();
    vi.stubGlobal("fetch", fetchPhoto);
    for (const publicUrl of [
      "https://cdn.fixture.invalid/avatar.jpg",
      "https://api.mtsc.top.evil.invalid/v1/technicians/tech-1/photos/photo-1",
      "https://evil.invalid/v1/technicians/tech-1/photos/photo-1",
      "https://api.mtsc.top:444/v1/technicians/tech-1/photos/photo-1",
    ]) {
      expect(await loadTechnicianPhotoPreview(publicUrl, "/v1", adminPath, "synthetic-token")).toBe(publicUrl);
    }
    expect(fetchPhoto).not.toHaveBeenCalled();
  });

  it("rejects admin mappings for another technician or an arbitrary private path", async () => {
    const fetchPhoto = vi.fn();
    vi.stubGlobal("fetch", fetchPhoto);
    for (const path of ["/admin/organizations/org-1/technicians/other-tech/profile", "/auth/logout", "//evil.invalid/profile"]) {
      await expect(loadTechnicianPhotoPreview(productionPhoto, "/v1", path, "synthetic-token")).rejects.toThrow("照片不属于当前技师资料");
    }
    expect(fetchPhoto).not.toHaveBeenCalled();
  });

  it("rejects a managed image URL carrying query, fragment, or credentials", async () => {
    const fetchPhoto = vi.fn();
    vi.stubGlobal("fetch", fetchPhoto);
    for (const url of [productionPhoto + "?redirect=https://evil.invalid", productionPhoto + "#fragment",
      productionPhoto.replace("https://", "https://name:password@")]) {
      await expect(loadTechnicianPhotoPreview(url, "/v1", adminPath, "synthetic-token")).rejects.toThrow("照片地址异常");
    }
    expect(fetchPhoto).not.toHaveBeenCalled();
  });

  it("rejects ambiguous API bases before any authenticated request", async () => {
    const fetchPhoto = vi.fn();
    vi.stubGlobal("fetch", fetchPhoto);
    for (const base of ["//api.mtsc.top/v1", "https://api.mtsc.top/v1?target=elsewhere", "https://api.mtsc.top/other",
      "http://untrusted.invalid/v1", "https://name:password@api.mtsc.top/v1", "/v1/admin"]) {
      await expect(loadTechnicianPhotoPreview(productionPhoto, base, adminPath, "synthetic-token")).rejects.toThrow("照片接口配置无效");
    }
    expect(fetchPhoto).not.toHaveBeenCalled();
  });

  it("does not interpret encoded image path suffixes as private identifiers", async () => {
    const fetchPhoto = vi.fn();
    vi.stubGlobal("fetch", fetchPhoto);
    const malformed = productionPhoto + "%2Fother";
    expect(await loadTechnicianPhotoPreview(malformed, "/v1", adminPath, "synthetic-token")).toBe(malformed);
    expect(fetchPhoto).not.toHaveBeenCalled();
  });

  it("refuses unauthorized and non-JPEG preview responses rather than creating unsafe blob URLs", async () => {
    const fetchPhoto = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("<html>not a photo</html>", { headers: { "Content-Type": "text/html" } }));
    vi.stubGlobal("fetch", fetchPhoto);
    const create = vi.spyOn(URL, "createObjectURL");
    await expect(loadTechnicianPhotoPreview(productionPhoto, "/v1", adminPath, "synthetic-token")).rejects.toThrow("本人照片预览读取失败");
    await expect(loadTechnicianPhotoPreview(productionPhoto, "/v1", adminPath, "synthetic-token")).rejects.toThrow("照片预览格式无效");
    expect(create).not.toHaveBeenCalled();
  });
});

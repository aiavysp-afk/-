import type { TechnicianProfile } from "@zydj/contracts";
import { getStoredSession } from "./auth";
import { api } from "./api";

export const canUploadOwnTechnicianPhotos = () => getStoredSession()?.user.memberships.some((membership) => membership.role === "THERAPIST") === true;

export async function refreshOwnTechnicianPhotoAccess() {
  const session = getStoredSession();
  if (!session) return false;
  // An invitation can change the membership while the cached login is still
  // valid. Read the authoritative session rather than asking the user to log out.
  const current = await api<{ id: string; memberships: { organizationId: string; role: string }[] }>("/auth/me");
  return current.id === session.user.id && current.memberships.some((membership) => membership.role === "THERAPIST");
}

export async function chooseTechnicianPhoto() {
  const selected = await new Promise<string>((resolve, reject) => wx.chooseMedia({
    count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["compressed"],
    success: (result) => result.tempFiles[0] ? resolve(result.tempFiles[0].tempFilePath) : reject(new Error("未选择照片")),
    fail: (error) => reject(new Error(/cancel/i.test(error.errMsg) ? "已取消选择" : "无法读取相册，请检查相册权限")),
  }));
  const path = await new Promise<string>((resolve, reject) => wx.compressImage({
    src: selected, quality: 60, compressedWidth: 1200,
    success: (result) => resolve(result.tempFilePath),
    fail: () => reject(new Error("照片压缩失败，请选择JPG或PNG照片")),
  }));
  const base64 = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, encoding: "base64", success: (result) => resolve(result.data),
    fail: () => reject(new Error("照片读取失败，请重新选择")),
  }));
  if (!base64.length || base64.length > 699_052) throw new Error("照片仍超过512KB，请裁剪后再上传");
  return { path, base64 };
}

export async function ownTechnicianPhotoPreview(profile: TechnicianProfile, publicUrl: string) {
  const session = getStoredSession();
  if (!session || profile.technicianId !== session.user.id) throw new Error("只能预览本人技师照片");
  const base = getApp<{ globalData: { apiBaseUrl: string } }>().globalData.apiBaseUrl;
  const prefix = `${base}/technicians/${encodeURIComponent(profile.technicianId)}/photos/`;
  if (!publicUrl.startsWith(prefix)) return publicUrl;
  const photoId = publicUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9-]+$/.test(photoId)) throw new Error("照片地址异常");
  return new Promise<string>((resolve, reject) => wx.downloadFile({
    url: `${base}/technician/workbench/profile/photos/${encodeURIComponent(photoId)}`,
    header: { Authorization: `Bearer ${session.accessToken}` },
    success: (result) => result.statusCode === 200 ? resolve(result.tempFilePath) : reject(new Error("照片预览暂不可用，请重新登录或联系平台")),
    fail: () => reject(new Error("照片预览下载失败，请稍后重试")),
  }));
}

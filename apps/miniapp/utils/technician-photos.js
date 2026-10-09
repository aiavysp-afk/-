"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canUploadOwnTechnicianPhotos = void 0;
exports.refreshOwnTechnicianPhotoAccess = refreshOwnTechnicianPhotoAccess;
exports.chooseTechnicianPhoto = chooseTechnicianPhoto;
exports.ownTechnicianPhotoPreview = ownTechnicianPhotoPreview;
const auth_1 = require("./auth");
const api_1 = require("./api");
const canUploadOwnTechnicianPhotos = () => { var _a; return ((_a = (0, auth_1.getStoredSession)()) === null || _a === void 0 ? void 0 : _a.user.memberships.some((membership) => membership.role === "THERAPIST")) === true; };
exports.canUploadOwnTechnicianPhotos = canUploadOwnTechnicianPhotos;
async function refreshOwnTechnicianPhotoAccess() {
    const session = (0, auth_1.getStoredSession)();
    if (!session)
        return false;
    // An invitation can change the membership while the cached login is still
    // valid. Read the authoritative session rather than asking the user to log out.
    const current = await (0, api_1.api)("/auth/me");
    return current.id === session.user.id && current.memberships.some((membership) => membership.role === "THERAPIST");
}
async function chooseTechnicianPhoto() {
    const selected = await new Promise((resolve, reject) => wx.chooseMedia({
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["compressed"],
        success: (result) => result.tempFiles[0] ? resolve(result.tempFiles[0].tempFilePath) : reject(new Error("未选择照片")),
        fail: (error) => reject(new Error(/cancel/i.test(error.errMsg) ? "已取消选择" : "无法读取相册，请检查相册权限")),
    }));
    const path = await new Promise((resolve, reject) => wx.compressImage({
        src: selected, quality: 60, compressedWidth: 1200,
        success: (result) => resolve(result.tempFilePath),
        fail: () => reject(new Error("照片压缩失败，请选择JPG或PNG照片")),
    }));
    const base64 = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
        filePath: path, encoding: "base64", success: (result) => resolve(result.data),
        fail: () => reject(new Error("照片读取失败，请重新选择")),
    }));
    if (!base64.length || base64.length > 699052)
        throw new Error("照片仍超过512KB，请裁剪后再上传");
    return { path, base64 };
}
async function ownTechnicianPhotoPreview(profile, publicUrl) {
    const session = (0, auth_1.getStoredSession)();
    if (!session || profile.technicianId !== session.user.id)
        throw new Error("只能预览本人技师照片");
    const base = getApp().globalData.apiBaseUrl;
    const prefix = `${base}/technicians/${encodeURIComponent(profile.technicianId)}/photos/`;
    if (!publicUrl.startsWith(prefix))
        return publicUrl;
    const photoId = publicUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9-]+$/.test(photoId))
        throw new Error("照片地址异常");
    return new Promise((resolve, reject) => wx.downloadFile({
        url: `${base}/technician/workbench/profile/photos/${encodeURIComponent(photoId)}`,
        header: { Authorization: `Bearer ${session.accessToken}` },
        success: (result) => result.statusCode === 200 ? resolve(result.tempFilePath) : reject(new Error("照片预览暂不可用，请重新登录或联系平台")),
        fail: () => reject(new Error("照片预览下载失败，请稍后重试")),
    }));
}

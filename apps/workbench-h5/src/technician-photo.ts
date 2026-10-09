export async function prepareTechnicianPhoto(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error("请选择10MB以内的本人JPG或PNG照片");
  }
  const image = await createImageBitmap(file);
  try {
    if (image.width * image.height > 16_000_000) throw new Error("照片像素过大，请先裁剪");
    const ratio = Math.min(1, 1200 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法压缩照片");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let base64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
    if (base64.length > 699_052) base64 = canvas.toDataURL("image/jpeg", 0.55).split(",")[1] ?? "";
    if (!base64 || base64.length > 699_052) throw new Error("照片压缩后仍超过512KB，请裁剪后重试");
    return base64;
  } finally { image.close(); }
}

export async function loadTechnicianPhotoPreview(publicUrl: string, apiBaseUrl: string, profilePath: string, token: string) {
  const apiBase = apiBaseUrl.replace(/\/$/, "");
  // Private production builds use /v1; persisted public photos still belong to
  // this project's HTTPS API. Never authenticate a fetch to the supplied URL.
  const api = new URL(apiBase, "https://api.mtsc.top");
  const localHttp = api.protocol === "http:" && ["127.0.0.1", "localhost"].includes(api.hostname);
  if (api.pathname !== "/v1" || api.search || api.hash || api.username || api.password ||
    (api.protocol !== "https:" && !localHttp) || (apiBase.startsWith("/") && apiBase !== "/v1")) {
    throw new Error("照片接口配置无效");
  }
  const photo = new URL(publicUrl);
  // Existing external CDN photos remain public and receive no Authorization.
  if (photo.origin !== api.origin) return publicUrl;
  const match = /^\/v1\/technicians\/([A-Za-z0-9_-]+)\/photos\/([A-Za-z0-9-]+)$/.exec(photo.pathname);
  if (!match) return publicUrl;
  const [, technicianId, photoId] = match;
  if (!technicianId || !photoId) return publicUrl;
  if (photo.search || photo.hash || photo.username || photo.password) throw new Error("照片地址异常");
  const admin = /^\/admin\/organizations\/[A-Za-z0-9_-]+\/technicians\/([A-Za-z0-9_-]+)\/profile$/.exec(profilePath);
  if (profilePath !== "/technician/workbench/profile" && (!admin || admin[1] !== technicianId)) {
    throw new Error("照片不属于当前技师资料");
  }
  const response = await fetch(`${apiBase}${profilePath}/photos/${encodeURIComponent(photoId)}`, {
    credentials: "omit", redirect: "error", headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("本人照片预览读取失败");
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") {
    throw new Error("照片预览格式无效");
  }
  return URL.createObjectURL(await response.blob());
}

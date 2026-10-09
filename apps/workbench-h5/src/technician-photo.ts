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
  if (!publicUrl.startsWith(`${apiBaseUrl}/technicians/`)) return publicUrl;
  const photoId = /\/photos\/([A-Za-z0-9-]+)$/.exec(publicUrl)?.[1];
  if (!photoId) return publicUrl;
  const response = await fetch(`${apiBaseUrl}${profilePath}/photos/${encodeURIComponent(photoId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("本人照片预览读取失败");
  return URL.createObjectURL(await response.blob());
}

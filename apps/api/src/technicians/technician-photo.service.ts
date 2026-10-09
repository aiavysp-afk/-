import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import type { AppEnv } from "../config/env.js";

export const MAX_TECHNICIAN_PHOTO_BYTES = 512 * 1024;
export const MAX_TECHNICIAN_PHOTO_COUNT = 24;
const MAX_INPUT_PIXELS = 16_000_000;

@Injectable()
export class TechnicianPhotoService {
  private processingCount = 0;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  publicUrl(technicianId: string, photoId: string) {
    const base = this.config.get("TECHNICIAN_PHOTO_PUBLIC_BASE_URL", { infer: true });
    if (!base) throw new ServiceUnavailableException("个人照片上传尚未配置，请联系平台设置照片服务地址");
    return `${base}/technicians/${encodeURIComponent(technicianId)}/photos/${encodeURIComponent(photoId)}`;
  }

  async normalize(base64: string) {
    if (base64.length > 699_052 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new BadRequestException("照片数据格式或大小无效");
    }
    const input = Buffer.from(base64, "base64");
    if (!input.length || input.length > MAX_TECHNICIAN_PHOTO_BYTES || input.toString("base64") !== base64) {
      throw new BadRequestException("请选择不超过512KB的JPG或PNG照片");
    }
    const jpeg = input[0] === 0xff && input[1] === 0xd8;
    const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!jpeg && !png) throw new BadRequestException("仅支持JPG和PNG照片，不支持证件文件、SVG或动图");
    // Native decoding is bounded in both payload and pixels; concurrent work is
    // capped before creating a libvips pipeline to avoid memory amplification.
    if (this.processingCount >= 2) throw new ServiceUnavailableException("照片处理繁忙，请稍后重试");
    this.processingCount += 1;
    try {
      const options = { failOn: "warning" as const, limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true };
      const metadata = await sharp(input, options).metadata();
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || !["jpeg", "png"].includes(metadata.format ?? "")) {
        throw new BadRequestException("照片无法读取或不是单张图片");
      }
      // rotate uses EXIF orientation; output deliberately omits all EXIF/GPS.
      const { data, info } = await sharp(input, options)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 80, mozjpeg: true })
        .timeout({ seconds: 5 })
        .toBuffer({ resolveWithObject: true });
      if (data.length > MAX_TECHNICIAN_PHOTO_BYTES) {
        throw new BadRequestException("照片压缩后仍过大，请裁剪后重试");
      }
      return { content: new Uint8Array(data), width: info.width, height: info.height, digest: createHash("sha256").update(data).digest("hex") };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) throw error;
      throw new BadRequestException("照片损坏、像素过大或格式不支持，请重新选择JPG或PNG照片");
    } finally {
      this.processingCount -= 1;
    }
  }
}

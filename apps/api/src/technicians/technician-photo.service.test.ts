import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_TECHNICIAN_PHOTO_BYTES, TechnicianPhotoService } from "./technician-photo.service.js";

const service = (base = "https://api.example.com/v1") => new TechnicianPhotoService({ get: () => base } as never);
const sample = async () => sharp({ create: { width: 180, height: 240, channels: 3, background: "#15a789" } }).jpeg().toBuffer();

describe("TechnicianPhotoService", () => {
  it("fails closed without the public API photo address", () => {
    expect(() => service("").publicUrl("tech-1", "photo-1")).toThrow(ServiceUnavailableException);
    expect(service().publicUrl("tech/1", "photo-1")).toBe("https://api.example.com/v1/technicians/tech%2F1/photos/photo-1");
  });

  it("decodes and re-encodes one JPEG, removing EXIF rather than trusting supplied content type", async () => {
    const original = await sharp(await sample()).withMetadata({ exif: { IFD0: { ImageDescription: "private photo GPS metadata test" } } }).toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const result = await service().normalize(original.toString("base64"));
    const metadata = await sharp(result.content).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 180, height: 240 });
    expect(metadata.exif).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_TECHNICIAN_PHOTO_BYTES);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts static PNG and limits the output longest edge to1600 pixels", async () => {
    const input = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: "#00ff0050" } }).png().toBuffer();
    const result = await service().normalize(input.toString("base64"));
    expect(result).toMatchObject({ width: 1600, height: 800 });
    expect((await sharp(result.content).metadata()).format).toBe("jpeg");
  });

  it("rejects SVG, fake JPEG, invalid canonical base64 and decoded over-limit payloads", async () => {
    const photos = service();
    for (const payload of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"), Buffer.from([255, 216, 1, 2, 3, 255, 217]).toString("base64"), "AB==", Buffer.alloc(MAX_TECHNICIAN_PHOTO_BYTES + 1).toString("base64")]) {
      await expect(photos.normalize(payload)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("rejects an image exceeding the decode pixel limit", async () => {
    const input = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(input.length).toBeLessThan(MAX_TECHNICIAN_PHOTO_BYTES);
    await expect(service().normalize(input.toString("base64"))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("bounds concurrent native decode work under a burst of authenticated uploads", async () => {
    const input = (await sample()).toString("base64");
    const photos = service();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => photos.normalize(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(10);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ServiceUnavailableException);
    await expect(photos.normalize(input)).resolves.toHaveProperty("digest");
  });
});

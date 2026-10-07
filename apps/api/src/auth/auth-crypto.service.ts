import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { AppEnv } from "../config/env.js";

@Injectable()
export class AuthCryptoService {
  private readonly encryptionKey: Buffer;
  private readonly pepper: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.encryptionKey = Buffer.from(
      String(config.get("DATA_ENCRYPTION_KEY_BASE64", { infer: true })),
      "base64",
    );
    this.pepper = String(config.get("AUTH_SESSION_PEPPER", { infer: true }));
    if (this.encryptionKey.length !== 32 || this.pepper.length < 32) {
      throw new Error("身份加密配置无效");
    }
  }

  createSessionToken() {
    return randomBytes(32).toString("base64url");
  }

  hashSessionToken(token: string) {
    return this.hash("session", token);
  }

  hashBrowserLogin(purpose: string, value: string) {
    return this.hash(`browser-login:${purpose}`, value);
  }

  hashIdentity(appId: string, subject: string) {
    return this.hash("wechat-miniapp-identity", `${appId}:${subject}`);
  }

  hashPhoneVerification(purpose: string, value: string) {
    return this.hash(`phone-verification:${purpose}`, value);
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(value: string) {
    const [version, ivEncoded, tagEncoded, payloadEncoded] = value.split(".");
    if (version !== "v1" || !ivEncoded || !tagEncoded || !payloadEncoded) {
      throw new Error("无法识别的密文格式");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivEncoded, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(payloadEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private hash(purpose: string, value: string) {
    return createHmac("sha256", this.pepper)
      .update(`${purpose}\0${value}`)
      .digest("hex");
  }
}

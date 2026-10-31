import "reflect-metadata";
import { Module, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import {
  AdminTechnicianIntakeController,
  PublicTechnicianIntakeController,
} from "./technician-intake.controller.js";
import { TechnicianIntakeService } from "./technician-intake.service.js";

// Isolated synthetic bytes and an in-memory lookup: no database, provider or
// real applicant images are contacted by this HTTP security test.
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const config = { get: () => "production" };
const crypto = new AuthCryptoService({
  get: (name: string) =>
    name === "DATA_ENCRYPTION_KEY_BASE64"
      ? Buffer.alloc(32, 9).toString("base64")
      : "isolated-intake-http-test-pepper-32-characters",
} as never);
const prisma = {
  technicianIntakeApplication: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
};
const intake = new TechnicianIntakeService(
  prisma as never,
  crypto,
  {} as never,
  new AccessControlService(config as never),
);

function actor(token: string): AuthPrincipal {
  const fresh = new Date(Date.now() + 300_000);
  const base: AuthPrincipal = {
    userId: "operator",
    sessionId: "isolated-session",
    displayName: "测试审核人员",
    authChannel: "ADMIN_BROWSER",
    staffVerifiedUntil: fresh,
    staffVerificationMethod: "PASSWORD_SMS",
    mfaVerifiedUntil: fresh,
    memberships: [
      {
        organizationId: token === "outside" ? "other-org" : "org-a",
        role:
          token === "customer-role"
            ? "CUSTOMER"
            : token === "therapist-role"
              ? "THERAPIST"
              : "OPERATOR",
      },
    ],
  };
  if (token === "customer-sms") return { ...base, authChannel: "CUSTOMER_SMS" };
  if (token === "customer-provider")
    return { ...base, authProvider: "customer-sms" };
  if (token === "technician-sms")
    return { ...base, authChannel: "TECHNICIAN_PHONE" };
  if (token === "technician-provider")
    return { ...base, authProvider: "technician-sms" };
  if (
    !["operator", "outside", "customer-role", "therapist-role"].includes(token)
  )
    throw new UnauthorizedException("请先登录");
  return base;
}
const auth = { authenticate: vi.fn(async (token: string) => actor(token)) };

@Module({
  controllers: [
    PublicTechnicianIntakeController,
    AdminTechnicianIntakeController,
  ],
  providers: [
    { provide: TechnicianIntakeService, useValue: intake },
    { provide: AuthService, useValue: auth },
    { provide: ConfigService, useValue: config },
    SessionAuthGuard,
  ],
})
class TestModule {}

describe("intake certificate actual HTTP privacy boundary", () => {
  let app: NestFastifyApplication;
  const url =
    "/v1/admin/organizations/org-a/simple/intakes/intake-a/certificate";
  const headers = { authorization: "Bearer operator" };

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    // Vitest does not emit Nest constructor metadata. Keep the real guard and
    // real service checks, supplying only isolated dependencies explicitly.
    Object.assign(app.get(SessionAuthGuard), { auth, config });
    Object.assign(app.get(AdminTechnicianIntakeController), { intake });
    Object.assign(app.get(PublicTechnicianIntakeController), { intake });
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.technicianIntakeApplication.findFirst.mockImplementation(
      async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === "intake-a" && where.organizationId === "org-a"
          ? {
              certificateEncrypted: crypto.encryptScoped(
                "technician-intake:intake-a:certificate",
                image.toString("base64"),
              ),
            }
          : null,
    );
    prisma.auditLog.create.mockResolvedValue({ id: "isolated-audit" });
  });

  afterAll(async () => app?.close());

  it("rejects anonymous, expired and query-token direct links before reading any image", async () => {
    for (const request of [
      { method: "GET" as const, url },
      { method: "HEAD" as const, url },
      { method: "GET" as const, url: `${url}?token=operator` },
      {
        method: "GET" as const,
        url,
        headers: { authorization: "Bearer expired-session" },
      },
      {
        method: "GET" as const,
        url,
        headers: { authorization: "Bearer operator extra" },
      },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(prisma.technicianIntakeApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("forbids customer and technician sessions even if they also hold an operator membership", async () => {
    for (const token of [
      "customer-sms",
      "customer-provider",
      "technician-sms",
      "technician-provider",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers["content-type"]).not.toContain("image/");
    }
    expect(prisma.technicianIntakeApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("forbids other organizations and non-reviewer roles before looking up a certificate", async () => {
    for (const token of ["outside", "customer-role", "therapist-role"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(prisma.technicianIntakeApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("serves only the scoped JPEG to an authorized reviewer with no-cache headers and a view audit", async () => {
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(image);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(prisma.technicianIntakeApplication.findFirst).toHaveBeenCalledWith({
      where: { id: "intake-a", organizationId: "org-a" },
      select: { certificateEncrypted: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "operator",
        organizationId: "org-a",
        action: "TECHNICIAN_INTAKE_CERTIFICATE_VIEWED",
        resourceType: "TechnicianIntakeApplication",
        resourceId: "intake-a",
        metadata: {},
      },
    });
  });

  it("does not disclose whether a guessed application exists in another organization", async () => {
    const response = await app.inject({
      method: "GET",
      url: url.replace("intake-a", "foreign-intake"),
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).not.toContain("image/");
    expect(prisma.technicianIntakeApplication.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-intake", organizationId: "org-a" },
      select: { certificateEncrypted: true },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a copied ciphertext from another application without returning image data or cryptographic details", async () => {
    prisma.technicianIntakeApplication.findFirst.mockResolvedValueOnce({
      certificateEncrypted: crypto.encryptScoped(
        "technician-intake:other-intake:certificate",
        image.toString("base64"),
      ),
    });
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe("证书照片暂时无法读取");
    expect(response.headers["content-type"]).not.toContain("image/");
    expect(response.body).not.toMatch(/cipher|decrypt|AES|base64|v2\./i);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("exposes no public GET, status or certificate alias on the anonymous submission route", async () => {
    for (const path of [
      "/v1/technician/intake",
      "/v1/technician/intake/intake-a",
      "/v1/technician/intake/intake-a/certificate",
      "/v1/technician/intake/status",
    ]) {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
        404,
      );
    }
    expect(prisma.technicianIntakeApplication.findFirst).not.toHaveBeenCalled();
  });
});

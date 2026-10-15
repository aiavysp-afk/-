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
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { AdminCustomerDirectoryController } from "./admin-customer-directory.controller.js";
import { AdminCustomerDirectoryService } from "./admin-customer-directory.service.js";

const createdAt = new Date("2026-10-15T10:00:00.000Z");
const row = {
  id: "customer-1",
  displayName: "客户",
  phoneEncrypted: "test-ciphertext",
  phoneVerifiedAt: createdAt,
  createdAt,
};
const prisma = {
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};
const config = { get: () => "production" };
const directory = new AdminCustomerDirectoryService(
  prisma as never,
  new AccessControlService(config as never),
  {
    decrypt: () => "13800138000",
    hashPhoneVerification: () => "keyed-test-reason-hash",
  } as never,
);

function actor(token: string): AuthPrincipal {
  const fresh = new Date(Date.now() + 300_000);
  const base: AuthPrincipal = {
    userId: "operator",
    sessionId: "session",
    displayName: "运营",
    authChannel: "ADMIN_BROWSER",
    mfaVerifiedUntil: fresh,
    memberships: [
      {
        organizationId: token === "outside" ? "other-org" : "org-1",
        role: token === "technician" ? "THERAPIST" : "OPERATOR",
      },
    ],
  };
  if (token === "trusted")
    return {
      ...base,
      mfaVerifiedUntil: null,
      staffVerifiedUntil: fresh,
      staffVerificationMethod: "TRUSTED_DEVICE",
    };
  if (token === "customer")
    return {
      ...base,
      authChannel: "CUSTOMER_SMS",
      authProvider: "customer-sms",
    };
  if (!["operator", "outside", "technician"].includes(token))
    throw new UnauthorizedException("请先登录");
  return base;
}
const auth = { authenticate: vi.fn(async (token: string) => actor(token)) };

@Module({
  controllers: [AdminCustomerDirectoryController],
  providers: [
    { provide: AdminCustomerDirectoryService, useValue: directory },
    { provide: AuthService, useValue: auth },
    { provide: ConfigService, useValue: config },
    SessionAuthGuard,
  ],
})
class TestModule {}

describe("customer directory actual HTTP boundary", () => {
  let app: NestFastifyApplication;
  const url = "/v1/admin/organizations/org-1/customer-center/customers";
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      TestModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    await app.init();
    // Vitest transpilation doesn't emit Nest constructor metadata.
    Object.assign(app.get(SessionAuthGuard), { auth, config });
    Object.assign(app.get(AdminCustomerDirectoryController), { directory });
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findMany.mockResolvedValue([row]);
    prisma.user.findFirst.mockResolvedValue(row);
    prisma.auditLog.create.mockResolvedValue({ id: "audit" });
    prisma.$transaction.mockImplementation(
      async (run: (tx: typeof prisma) => unknown) => run(prisma),
    );
  });
  afterAll(async () => app?.close());

  it("rejects anonymous list and reveal requests before reading customer records", async () => {
    for (const request of [
      { method: "GET" as const, url },
      {
        method: "POST" as const,
        url: `${url}/customer-1/reveal-phone`,
        payload: { reason: "核实客户预约" },
      },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("protects both routes from customers, technicians and other organizations", async () => {
    for (const token of ["customer", "technician", "outside"]) {
      const headers = { authorization: `Bearer ${token}` };
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/customer-1/reveal-phone`,
            headers,
            payload: { reason: "核实客户预约" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns only masked phones and no-store headers to an existing operator", async () => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer operator" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.json().data.items[0]).toMatchObject({
      userId: row.id,
      maskedPhone: "138****8000",
    });
    expect(response.body).not.toMatch(
      /13800138000|test-ciphertext|phoneEncrypted/,
    );
  });

  it("permits a trusted-device masked read but rejects full-phone POST without fresh MFA", async () => {
    const headers = { authorization: "Bearer trusted" };
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(
      200,
    );
    const denied = await app.inject({
      method: "POST",
      url: `${url}/customer-1/reveal-phone`,
      headers,
      payload: { reason: "核实客户预约" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("动态码");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("reveals only through authenticated POST after fresh MFA and persists a non-PII audit", async () => {
    const headers = { authorization: "Bearer operator" };
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${url}/customer-1/reveal-phone`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const response = await app.inject({
      method: "POST",
      url: `${url}/customer-1/reveal-phone`,
      headers,
      payload: { reason: "核实客户预约 13800138000" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.json().data).toMatchObject({
      userId: row.id,
      phone: "13800138000",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toMatch(
      /13800138000|核实客户预约|test-ciphertext/,
    );
  });

  it("rejects missing reasons, unauthorized scope switches and unbounded lists", async () => {
    const headers = { authorization: "Bearer operator" };
    for (const payload of [
      {},
      { reason: "查看" },
      { reason: "核实客户预约", mfaVerified: true },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/customer-1/reveal-phone`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (await app.inject({ method: "GET", url: `${url}?limit=101`, headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${url}?organizationId=other`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

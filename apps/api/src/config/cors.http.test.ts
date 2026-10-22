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
import { readFileSync } from "node:fs";
import { AuthService } from "../auth/auth.service.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { TechnicianPhoneOnboardingController } from "../technicians/technician-phone-onboarding.controller.js";
import { TechniciansService } from "../technicians/technicians.service.js";
import { apiCorsOptions } from "./cors.js";

const origin = "https://mtsc.top";
const profile = "/v1/technician/phone-onboarding/profile";
const config = new ConfigService({
  TECHNICIAN_PHONE_LOGIN_ENABLED: "true",
  TECHNICIAN_PHONE_WORKBENCH_ENABLED: "false",
});
const technicians = {
  phoneOnboardingStatus: vi
    .fn()
    .mockResolvedValue({
      stage: "PROFILE_REQUIRED",
      phoneMasked: "138****8000",
      application: null,
    }),
  registerPhone: vi
    .fn()
    .mockResolvedValue({
      stage: "PROFILE_REQUIRED",
      phoneMasked: "138****8000",
      application: null,
    }),
  updatePhoneApplication: vi
    .fn()
    .mockResolvedValue({
      stage: "PROFILE_REQUIRED",
      phoneMasked: "138****8000",
      application: { status: "DRAFT", bio: "先保存" },
    }),
};
const auth = {
  authenticate: vi.fn(async (token: string) => {
    if (token !== "technician-fixture" && token !== "customer-fixture")
      throw new UnauthorizedException("请先登录");
    return {
      sessionId: "fixture-session",
      userId: "fixture-user",
      displayName: "Fixture",
      authChannel:
        token === "customer-fixture" ? "CUSTOMER_SMS" : "TECHNICIAN_PHONE",
      authProvider:
        token === "customer-fixture" ? "customer-sms" : "technician-sms",
      memberships: [],
      phoneVerified: true,
    };
  }),
};
@Module({
  controllers: [TechnicianPhoneOnboardingController],
  providers: [
    { provide: TechniciansService, useValue: technicians },
    { provide: AuthService, useValue: auth },
    { provide: ConfigService, useValue: config },
    SessionAuthGuard,
  ],
})
class CorsHttpModule {}

describe("production-shared CORS policy on actual Nest/Fastify HTTP routes", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      CorsHttpModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("v1");
    app.enableCors(apiCorsOptions(`${origin}, https://admin.mtsc.top`));
    await app.init();
    // Vitest does not emit Nest's constructor metadata, so wire these real guards explicitly.
    Object.assign(app.get(SessionAuthGuard), { auth, config });
    Object.assign(app.get(TechnicianPhoneOnboardingController), {
      technicians,
    });
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app?.close());
  const methods = (value: unknown) =>
    String(value ?? "")
      .split(",")
      .map((part) => part.trim().toUpperCase());
  const headers = (value: unknown) =>
    String(value ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase());

  it("allows H5 profile PATCH preflight with Authorization and Content-Type without authenticating preflight", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: profile,
      headers: {
        origin,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(methods(response.headers["access-control-allow-methods"])).toContain(
      "PATCH",
    );
    expect(headers(response.headers["access-control-allow-headers"])).toEqual(
      expect.arrayContaining(["authorization", "content-type"]),
    );
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(technicians.updatePhoneApplication).not.toHaveBeenCalled();
  });
  it.each([
    "https://evil.test",
    "https://mtsc.top.evil.test",
    "null",
    "http://mtsc.top",
  ])("does not grant cross-origin access to %s", async (badOrigin) => {
    const response = await app.inject({
      method: "OPTIONS",
      url: profile,
      headers: {
        origin: badOrigin,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    // A CORS refusal is the absence of an ACAO grant, not necessarily HTTP 403.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(technicians.updatePhoneApplication).not.toHaveBeenCalled();
  });
  it("lets the authorized browser perform the actual PATCH and read its no-store response", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: profile,
      headers: {
        origin,
        authorization: "Bearer technician-fixture",
        "content-type": "application/json",
      },
      payload: { bio: "先保存" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(technicians.updatePhoneApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "fixture-user",
        authProvider: "technician-sms",
      }),
      { bio: "先保存" },
    );
  });
  it("does not turn preflight approval into anonymous or customer-SMS technician authority", async () => {
    for (const authorization of [undefined, "Bearer customer-fixture"]) {
      const response = await app.inject({
        method: "PATCH",
        url: profile,
        headers: {
          origin,
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        payload: { bio: "先保存" },
      });
      expect(response.statusCode).toBe(authorization ? 403 : 401);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    }
    expect(technicians.updatePhoneApplication).not.toHaveBeenCalled();
  });
  it.each(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"])(
    "advertises existing controller method %s, not arbitrary methods",
    async (method) => {
      const response = await app.inject({
        method: "OPTIONS",
        url: profile,
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers":
            "authorization,content-type,idempotency-key",
        },
      });
      expect(response.statusCode).toBe(204);
      expect(
        methods(response.headers["access-control-allow-methods"]),
      ).toContain(method);
      expect(
        methods(response.headers["access-control-allow-methods"]),
      ).not.toEqual(expect.arrayContaining(["TRACE", "CONNECT"]));
      expect(
        headers(response.headers["access-control-allow-headers"]),
      ).toContain("idempotency-key");
    },
  );
  it("keeps existing GET status and POST register functional with the same origin policy", async () => {
    const common = { origin, authorization: "Bearer technician-fixture" };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/technician/phone-onboarding/status",
          headers: common,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/technician/phone-onboarding/register",
          headers: { ...common, "content-type": "application/json" },
          payload: {},
        })
      ).statusCode,
    ).toBe(201);
  });
  it("bootstrap consumes this exact centralized policy, retaining configured origins and existing credentials policy", () => {
    const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(source).toContain(
      'apiCorsOptions(config.get("CORS_ORIGINS", { infer: true }))',
    );
    expect(apiCorsOptions(` ${origin} , https://admin.mtsc.top `)).toEqual({
      origin: [origin, "https://admin.mtsc.top"],
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
    });
    expect(apiCorsOptions(origin)).not.toHaveProperty("allowedHeaders");
  });
});

import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechniciansService } from "./technicians.service.js";
import { TechnicianPhoneOnboardingController } from "./technician-phone-onboarding.controller.js";
import { TechnicianWorkbenchService } from "../orders/technician-workbench.service.js";
import { readFileSync } from "node:fs";

const applicant: AuthPrincipal = {
  sessionId: "s",
  userId: "owner",
  displayName: "Fixture",
  memberships: [],
  authChannel: "TECHNICIAN_PHONE",
  authProvider: "technician-sms",
  phoneVerified: true,
};
const admin: AuthPrincipal = {
  sessionId: "a",
  userId: "admin",
  displayName: "Fixture Admin",
  memberships: [{ organizationId: "org", role: "OPERATOR" }],
  authChannel: "ADMIN_BROWSER",
  mfaVerifiedUntil: new Date(Date.now() + 60000),
};
const draft = {
  realName: "测试姓名",
  serviceCity: "郑州市",
  serviceAreas: ["金水区"],
  availableTimeSlots: ["MON:09:00-18:00"],
  bio: "本人真实填写的服务经验介绍",
  serviceIds: ["service"],
};
function fixture(overrides = {}) {
  const config = new ConfigService({
    TECHNICIAN_PHONE_LOGIN_ENABLED: "true",
    TECHNICIAN_PHONE_WORKBENCH_ENABLED: "false",
    SERVICE_CITY: "郑州市",
    AUTH_SESSION_PEPPER: "fixture-technician-pepper-not-production",
    DATA_ENCRYPTION_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ...overrides,
  });
  const crypto = new AuthCryptoService(config as never),
    phone = "13800138000";
  const current: any = {
    id: "profile",
    technicianId: "owner",
    organizationId: "org",
    publicName: "",
    ageRange: null,
    avatarUrl: "https://fixture.invalid/avatar",
    galleryUrls: [],
    introduction: draft.bio,
    specialties: ["测试项目"],
    serviceYears: null,
    certificates: [],
    status: "DRAFT",
    selfRegistered: true,
    registrationChannel: "TECHNICIAN_PHONE",
    realNameEncrypted: crypto.encryptScoped(
      "technician-real-name:profile",
      draft.realName,
    ),
    serviceCity: draft.serviceCity,
    serviceAreas: draft.serviceAreas,
    availableTimeSlots: draft.availableTimeSlots,
    serviceIds: draft.serviceIds,
    rejectionReason: null,
    version: 4,
    updatedAt: new Date(),
    technician: { displayName: "Fixture" },
  };
  const user: any = {
    status: "ACTIVE",
    phoneEncrypted: crypto.encrypt(phone),
    phoneVerifiedAt: new Date(),
    customerPhoneIdentity: {
      phoneHash: crypto.hashPhoneVerification("phone", phone),
    },
    identities: [],
  };
  const tx = {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn(async () => user) },
    organization: { findMany: vi.fn().mockResolvedValue([{ id: "org" }]) },
    staffMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    technicianProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(current),
      findUniqueOrThrow: vi.fn(async () => structuredClone(current)),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(current, {
          ...data,
          ...(data.version
            ? { version: current.version + data.version.increment }
            : {}),
        });
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn() },
  };
  const prisma: any = {
    $transaction: vi.fn(async (operation) => operation(tx)),
    user: tx.user,
    technicianProfile: {
      findFirst: vi.fn(async () => structuredClone(current)),
      findUnique: vi.fn(async () => structuredClone(current)),
    },
    technicianIdentityDocument: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ kind: "ID_FRONT" }, { kind: "ID_BACK" }]),
    },
    service: {
      findMany: vi.fn(async ({ where }) =>
        where.id.in.map((id: string) => ({ id, name: "测试项目" })),
      ),
      count: vi.fn().mockResolvedValue(1),
    },
    technicianPhoto: { findFirst: vi.fn().mockResolvedValue({ id: "photo" }) },
    technicianReview: {
      aggregate: vi
        .fn()
        .mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: { count: vi.fn().mockResolvedValue(0) },
    staffMembership: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const access = { assertPermission: vi.fn() },
    photos = { normalize: vi.fn() };
  const service = new TechniciansService(
    prisma,
    access as never,
    photos as never,
    crypto,
    config as never,
  );
  return { config, crypto, phone, user, current, tx, prisma, access, service };
}

describe("phone onboarding owner state machine", () => {
  it("register creates only a same-owner DRAFT and grants no membership", async () => {
    const f = fixture();
    await f.service.registerPhone(applicant);
    expect(f.tx.technicianProfile.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org",
        technicianId: "owner",
        publicName: "",
        selfRegistered: true,
        registrationChannel: "TECHNICIAN_PHONE",
        status: "DRAFT",
      },
    });
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
  });
  it.each([
    { authChannel: "CUSTOMER_SMS", authProvider: "customer-sms" },
    { authChannel: "WECHAT_MINIAPP", authProvider: "wechat" },
    { authProvider: "wechat" },
    { phoneVerified: false },
  ])(
    "phone wrappers reject other authentication proof before writes: %j",
    async (fields) => {
      const f = fixture();
      await expect(
        f.service.registerPhone({ ...applicant, ...fields }),
      ).rejects.toThrow("手机号验证码");
      expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
    },
  );
  it("native and old H5 routes continue to reject phone-source sessions", async () => {
    const f = fixture();
    await expect(f.service.register(applicant)).rejects.toThrow("微信");
    await expect(f.service.onboarding(applicant)).rejects.toThrow("微信");
    await expect(f.service.miniappApplicationStatus(applicant)).rejects.toThrow(
      "微信小程序",
    );
    await expect(f.service.h5OnboardingStatus(applicant)).rejects.toThrow(
      "H5链接",
    );
  });
  it.each(["status", "phone", "binding", "gate", "tenant", "legacy"])(
    "fails closed on %s registration state",
    async (issue) => {
      const f = fixture();
      if (issue === "status") f.user.status = "DISABLED";
      if (issue === "phone") f.user.phoneVerifiedAt = null;
      if (issue === "binding")
        f.user.customerPhoneIdentity.phoneHash = "mismatched";
      if (issue === "gate")
        f.config.set("TECHNICIAN_PHONE_LOGIN_ENABLED", "false");
      if (issue === "tenant")
        f.tx.organization.findMany.mockResolvedValue([
          { id: "org" },
          { id: "other" },
        ]);
      if (issue === "legacy")
        f.tx.technicianProfile.findUnique.mockResolvedValue({
          ...f.current,
          selfRegistered: false,
        });
      await expect(f.service.registerPhone(applicant)).rejects.toThrow();
      expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
    },
  );
  it("idempotently reuses self-registered owner record without replacing its registration channel or photos", async () => {
    const f = fixture();
    f.tx.technicianProfile.findUnique.mockResolvedValue({
      ...f.current,
      registrationChannel: "WECHAT_MINIAPP",
    });
    await f.service.registerPhone(applicant);
    expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
    expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
  });
  it("saves incomplete draft without requiring photos or complete text and refuses its submission", async () => {
    const f = fixture();
    f.current.realNameEncrypted = null;
    f.current.serviceAreas = [];
    f.current.availableTimeSlots = [];
    f.current.serviceIds = [];
    f.current.introduction = "";
    f.current.avatarUrl = null;
    const saved = await f.service.updatePhoneApplication(applicant, {
      bio: "先保存",
    });
    expect(saved.application?.bio).toBe("先保存");
    expect(saved.application?.status).toBe("DRAFT");
    await expect(f.service.submitPhoneApplication(applicant)).rejects.toThrow(
      "填写完整",
    );
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
  });
  it("preserves unchanged private fields in partial patch, encrypts name and audits only field names", async () => {
    const f = fixture();
    const result = await f.service.updatePhoneApplication(applicant, {
      bio: "本次只修改了真实个人服务经验介绍",
    });
    expect(result.application?.realName).toBe(draft.realName);
    expect(result.application?.serviceIds).toEqual(draft.serviceIds);
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      draft.realName,
    );
    expect(f.current.realNameEncrypted).not.toBe(draft.realName);
  });
  it("refuses lost partial update if the source version changes before write", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findFirst.mockResolvedValueOnce({
      ...f.current,
      version: 3,
    });
    await expect(
      f.service.updatePhoneApplication(applicant, {
        bio: "本次提交的真实简介",
      }),
    ).rejects.toThrow("已变化");
    expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
  });
  it.each(["PENDING_REVIEW", "APPROVED", "PUBLISHED"])(
    "rejects phone edits and image writes while %s",
    async (status) => {
      const f = fixture();
      f.current.status = status;
      await expect(
        f.service.updatePhoneApplication(applicant, {
          bio: "本次提交的真实简介",
        }),
      ).rejects.toThrow("不能继续修改");
      await expect(
        f.service.uploadPhoneIdentityDocument(applicant, {
          kind: "ID_FRONT",
          contentBase64: "AAAA",
        }),
      ).rejects.toThrow("不能继续修改");
    },
  );
  it("submits complete same record to PENDING_REVIEW and keeps repeat submit idempotent", async () => {
    const f = fixture();
    expect((await f.service.submitPhoneApplication(applicant)).stage).toBe(
      "PENDING_REVIEW",
    );
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    const calls = f.tx.technicianProfile.updateMany.mock.calls.length;
    expect((await f.service.submitPhoneApplication(applicant)).stage).toBe(
      "PENDING_REVIEW",
    );
    expect(f.tx.technicianProfile.updateMany.mock.calls.length).toBe(calls);
  });
  it("rejects missing document and removed catalog service at submission", async () => {
    const f = fixture();
    f.prisma.technicianIdentityDocument.findMany.mockResolvedValue([
      { kind: "ID_FRONT" },
    ]);
    await expect(f.service.submitPhoneApplication(applicant)).rejects.toThrow(
      "身份证正反面",
    );
    const g = fixture();
    g.prisma.service.count.mockResolvedValue(0);
    await expect(g.service.submitPhoneApplication(applicant)).rejects.toThrow(
      "项目状态已变化",
    );
  });
  it("REJECTED can be edited then explicitly resubmitted; never silently approved", async () => {
    const f = fixture();
    f.current.status = "REJECTED";
    f.current.rejectionReason = "测试退回原因";
    await f.service.updatePhoneApplication(applicant, {
      bio: "本人按退回要求补充真实经验介绍",
    });
    expect(f.current.status).toBe("DRAFT");
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    await f.service.submitPhoneApplication(applicant);
    expect(f.current.status).toBe("PENDING_REVIEW");
  });
  it("existing backend approval checks permission, snapshot version and canonical phone, then alone grants THERAPIST", async () => {
    const f = fixture();
    f.current.status = "PENDING_REVIEW";
    await f.service.approve(admin, "org", "owner", 4);
    expect(f.access.assertPermission).toHaveBeenCalledWith(
      admin,
      "technicians.manage",
      "org",
    );
    expect(f.tx.staffMembership.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        organizationId: "org",
        role: "THERAPIST",
        status: "ACTIVE",
      },
    });
    expect(f.current.status).toBe("APPROVED");
  });
  it.each(["disabled", "phone", "revoked-membership", "wrong-org", "version"])(
    "approval refuses %s without restoring authority",
    async (issue) => {
      const f = fixture();
      f.current.status = "PENDING_REVIEW";
      if (issue === "disabled") f.user.status = "DISABLED";
      if (issue === "phone") f.user.customerPhoneIdentity.phoneHash = "wrong";
      if (issue === "revoked-membership")
        f.tx.staffMembership.findMany.mockResolvedValue([
          { organizationId: "org", status: "DISABLED" },
        ] as never);
      if (issue === "wrong-org")
        f.tx.staffMembership.findMany.mockResolvedValue([
          { organizationId: "other", status: "ACTIVE" },
        ] as never);
      await expect(
        f.service.approve(admin, "org", "owner", issue === "version" ? 2 : 4),
      ).rejects.toThrow();
      expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    },
  );
  it.each(["approve", "publish"])(
    "%s rechecks phone application documents and current service publication",
    async (action) => {
      for (const missing of ["documents", "services"]) {
        const f = fixture();
        f.current.status = action === "approve" ? "PENDING_REVIEW" : "APPROVED";
        if (missing === "documents")
          f.prisma.technicianIdentityDocument.findMany.mockResolvedValue([]);
        else f.prisma.service.count.mockResolvedValue(0);
        await expect(
          action === "approve"
            ? f.service.approve(admin, "org", "owner", 4)
            : f.service.publish(admin, "org", "owner"),
        ).rejects.toThrow();
        expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
        expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
      }
    },
  );
  it("owner material queries cannot accept a different account or organization", async () => {
    const f = fixture();
    await f.service.phoneOnboardingStatus(applicant);
    expect(f.prisma.technicianProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          technicianId: "owner",
          selfRegistered: true,
          technician: { status: "ACTIVE" },
        },
      }),
    );
    const c = new TechnicianPhoneOnboardingController(f.service);
    await expect(c.register(applicant, { userId: "other" })).rejects.toThrow(
      "额外身份",
    );
    await expect(
      c.profile(applicant, { ...draft, status: "APPROVED" }),
    ).rejects.toThrow("格式无效");
    await expect(
      c.submit(applicant, { organizationId: "other" }),
    ).rejects.toThrow("额外身份");
  });
});

describe("phone workbench minimum authority", () => {
  it.each([
    "login-closed",
    "workbench-closed",
    "pending",
    "no-role",
    "wrong-source",
  ])("does not bypass MFA/approval for %s", async (issue) => {
    const f = fixture({ TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true" });
    if (issue === "login-closed")
      f.config.set("TECHNICIAN_PHONE_LOGIN_ENABLED", "false");
    if (issue === "workbench-closed")
      f.config.set("TECHNICIAN_PHONE_WORKBENCH_ENABLED", "false");
    if (issue === "pending")
      f.prisma.technicianProfile.findFirst.mockResolvedValue(null);
    const p = {
      ...applicant,
      memberships:
        issue === "no-role"
          ? []
          : [{ organizationId: "org", role: "THERAPIST" as const }],
      ...(issue === "wrong-source" ? { authProvider: "customer-sms" } : {}),
    };
    const service = new TechnicianWorkbenchService(
      f.prisma,
      f.access as never,
      {} as never,
      undefined,
      f.crypto,
      f.config as never,
    );
    await expect((service as any).assertOwnAccess(p, "org")).rejects.toThrow();
  });
  it("allows only same active approved therapist and retains explicit DB ownership filtering", async () => {
    const f = fixture({ TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true" }),
      service = new TechnicianWorkbenchService(
        f.prisma,
        f.access as never,
        {} as never,
        undefined,
        f.crypto,
        f.config as never,
      );
    await expect(
      (service as any).assertOwnAccess(
        {
          ...applicant,
          memberships: [{ organizationId: "org", role: "THERAPIST" }],
        },
        "org",
      ),
    ).resolves.toBeUndefined();
    expect(f.prisma.technicianProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          technicianId: "owner",
          organizationId: "org",
          status: { in: ["APPROVED", "PUBLISHED"] },
          technician: {
            status: "ACTIVE",
            memberships: {
              some: {
                role: "THERAPIST",
                organizationId: "org",
                status: "ACTIVE",
              },
            },
          },
        }),
      }),
    );
    await expect(
      (service as any).assertOwnAccess(
        {
          ...applicant,
          memberships: [{ organizationId: "org", role: "THERAPIST" }],
        },
        "other",
      ),
    ).rejects.toThrow();
    expect(f.access.assertPermission).not.toHaveBeenCalled();
  });
});

it("migration isolates nullable source comparisons and does not seed users or authority", () => {
  const sql = readFileSync(
    new URL(
      "../../prisma/migrations/20261022010000_technician_phone_login/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  expect(sql).toContain('"Session_technician_phone_scope_check"');
  expect(sql).toContain("IS DISTINCT FROM 'TECHNICIAN_PHONE'");
  expect(sql).toContain("IS NOT DISTINCT FROM 'technician-sms'");
  expect(sql).toContain('"mfaVerifiedUntil" IS NULL');
  expect(sql).not.toMatch(
    /INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|UPDATE\s+"User"/i,
  );
  const old = readFileSync(
    new URL(
      "../../prisma/migrations/20261014050000_customer_single_step_login/migration.sql",
      import.meta.url,
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = old.indexOf(
    'ADD CONSTRAINT "Session_auth_provenance_check" CHECK (',
  );
  const previousBranches = old
    .slice(start)
    .split("CHECK (", 2)[1]!
    .split("\n);", 1)[0]!
    .trim();
  expect(sql.replace(/\r\n/g, "\n")).toContain(`${previousBranches} OR`);
  expect(sql).toContain('DROP CONSTRAINT "Session_auth_provenance_check"');
  expect(sql).toContain('ADD CONSTRAINT "Session_auth_provenance_check"');
});

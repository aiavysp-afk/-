import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  AccountDeletionRequestStatus,
  CustomerFeedbackStatus,
  UserRole,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { PrismaService } from "../database/prisma.service.js";
import { CustomerCenterService } from "./customer-center.service.js";

const customer: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "customer-1",
  displayName: "微信用户",
  memberships: [],
};

const crypto = {
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
} as unknown as AuthCryptoService;

const eligibleOrganization = () => ({
  organization: { findUnique: vi.fn().mockResolvedValue({ id: "org-1" }) },
  service: {
    findFirst: vi
      .fn()
      .mockResolvedValue({ id: "service-1", organizationId: "org-1" }),
  },
  order: { findFirst: vi.fn().mockResolvedValue(null) },
});

describe("CustomerCenterService", () => {
  it("encrypts address PII and guarantees the first address is the default", async () => {
    const createdAt = new Date("2026-10-09T10:00:00.000Z");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      customerAddress: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockImplementation(({ data }) => ({
          id: "address-1",
          ...data,
          createdAt,
          updatedAt: createdAt,
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(null) },
      service: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    const result = await service.createAddress(customer, {
      contactName: "张三",
      phone: "13800138000",
      detail: "郑州市金水区测试路 1 号",
      latitude: 34.75,
      longitude: 113.65,
      coordinateSystem: "GCJ-02",
      isDefault: false,
    });

    expect(tx.customerAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: "customer-1",
        organizationId: "org-1",
        contactNameEncrypted: "enc:张三",
        phoneEncrypted: "enc:13800138000",
        detailEncrypted: "enc:郑州市金水区测试路 1 号",
        coordinateSystem: "GCJ-02",
        isDefault: true,
      }),
    });
    expect(tx.customerAddress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", customerId: "customer-1" },
      data: { isDefault: false },
    });
    expect(result).toMatchObject({
      contactName: "张三",
      phone: "13800138000",
      isDefault: true,
    });
  });

  it("rejects an attempt to update another customer's address before writing", async () => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      customerAddress: {
        findUnique: vi.fn().mockResolvedValue({
          id: "address-other",
          customerId: "customer-other",
        }),
        update,
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await expect(
      service.updateAddress(customer, "address-other", { contactName: "李四" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects address creation after the per-organization limit is reached", async () => {
    const create = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      customerAddress: {
        count: vi.fn().mockResolvedValue(50),
        updateMany: vi.fn(),
        create,
      },
    };
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(null) },
      service: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await expect(
      service.createAddress(customer, {
        contactName: "张三",
        phone: "13800138000",
        detail: "郑州市金水区测试路 1 号",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns an existing pending deletion request idempotently", async () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    const pending = {
      id: "delete-1",
      organizationId: "org-previous",
      customerId: "customer-1",
      reasonEncrypted: null,
      status: AccountDeletionRequestStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const create = vi.fn();
    const audit = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountDeletionRequest: {
        findFirst: vi.fn().mockResolvedValue(pending),
        create,
      },
      auditLog: { create: audit },
    };
    const prisma = {
      ...eligibleOrganization(),
      accountDeletionRequest: {
        findFirst: vi.fn().mockResolvedValue(pending),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    const result = await service.requestAccountDeletion(customer, {
      organizationId: "org-1",
      acknowledgedRisk: true,
    });

    expect(result.id).toBe("delete-1");
    expect(result.organizationId).toBe("org-previous");
    expect(prisma.accountDeletionRequest.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: "customer-1",
        status: AccountDeletionRequestStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("reads the latest account deletion request globally across organizations", async () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    const findFirst = vi.fn().mockResolvedValue({
      id: "delete-global",
      organizationId: "org-previous",
      customerId: "customer-1",
      reasonEncrypted: null,
      status: AccountDeletionRequestStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const service = new CustomerCenterService(
      {
        accountDeletionRequest: { findFirst },
      } as unknown as PrismaService,
      new AccessControlService(),
      crypto,
    );

    const result = await service.accountDeletion(customer, "org-new");

    expect(result?.organizationId).toBe("org-previous");
    expect(findFirst).toHaveBeenCalledWith({
      where: { customerId: "customer-1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("encrypts feedback content and contact before persistence", async () => {
    const createdAt = new Date("2026-10-09T10:00:00.000Z");
    const create = vi.fn().mockImplementation(({ data }) => ({
      id: "feedback-1",
      ...data,
      status: CustomerFeedbackStatus.OPEN,
      createdAt,
    }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      customerFeedback: { count: vi.fn().mockResolvedValue(0), create },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      ...eligibleOrganization(),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await service.createFeedback(customer, {
      organizationId: "org-1",
      category: "GENERAL",
      content: "希望预约流程可以增加文字提示",
      contact: "13800138000",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contentEncrypted: "enc:希望预约流程可以增加文字提示",
        contactEncrypted: "enc:13800138000",
      }),
    });
    expect(create.mock.calls[0]?.[0]?.data).not.toHaveProperty("content");
    expect(create.mock.calls[0]?.[0]?.data).not.toHaveProperty("contact");
  });

  it("rate limits feedback to ten persisted submissions per Shanghai day", async () => {
    const create = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      customerFeedback: {
        count: vi.fn().mockResolvedValue(10),
        create,
      },
    };
    const prisma = {
      ...eligibleOrganization(),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await expect(
      service.createFeedback(customer, {
        organizationId: "org-1",
        category: "GENERAL",
        content: "这是当天第十一次反馈提交，应该被持久化限流拦截",
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(create).not.toHaveBeenCalled();
  });

  it("encrypts a new account deletion reason and never returns it", async () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    const create = vi.fn().mockImplementation(({ data }) => ({
      id: "delete-new",
      ...data,
      status: AccountDeletionRequestStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }));
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountDeletionRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      ...eligibleOrganization(),
      accountDeletionRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    const result = await service.requestAccountDeletion(customer, {
      organizationId: "org-1",
      reason: "不再使用服务",
      acknowledgedRisk: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasonEncrypted: "enc:不再使用服务",
      }),
    });
    expect(create.mock.calls[0]?.[0]?.data).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("reason");
  });

  it("rejects an explicit organization without a published service or prior customer order", async () => {
    const prisma = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({ id: "org-other" }),
      },
      service: { findFirst: vi.fn().mockResolvedValue(null) },
      order: { findFirst: vi.fn().mockResolvedValue(null) },
      customerAddress: { findMany: vi.fn() },
    } as unknown as PrismaService;
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await expect(
      service.addresses(customer, "org-other"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.customerAddress.findMany).not.toHaveBeenCalled();
  });

  it("fills complete defaults when the first admin config patch is partial", async () => {
    const updatedAt = new Date("2026-10-09T10:00:00.000Z");
    const upsert = vi.fn().mockResolvedValue({
      levelLabel: "普通用户",
      customerServicePhone: null,
      cityNewsTitle: "今日服务正常",
      cityNewsContent: "中原到家持续为郑州用户提供规范上门服务",
      appBannerTitle: "中原到家小程序",
      appBannerSubtitle: "无需下载 APP，微信内即可预约",
      appDownloadUrl: null,
      safeguardItems: ["价格透明", "服务留痕", "售后保障"],
      updatedAt,
    });
    const tx = {
      customerCenterConfig: { upsert },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      organization: { findUnique: vi.fn().mockResolvedValue({ id: "org-1" }) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const operator: AuthPrincipal = {
      ...customer,
      memberships: [{ organizationId: "org-1", role: UserRole.OPERATOR }],
    };
    const service = new CustomerCenterService(
      prisma,
      new AccessControlService(),
      crypto,
    );

    await service.updateAdminConfig(operator, "org-1", {
      cityNewsTitle: "今日服务正常",
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: "org-1",
          levelLabel: "普通用户",
          cityNewsTitle: "今日服务正常",
          safeguardItems: ["价格透明", "服务留痕", "售后保障"],
        }),
      }),
    );
  });

  it("does not expose organization financial summaries to staff outside that organization", async () => {
    const principal: AuthPrincipal = {
      ...customer,
      memberships: [{ organizationId: "org-other", role: UserRole.OPERATOR }],
    };
    const service = new CustomerCenterService(
      {} as PrismaService,
      new AccessControlService(),
      crypto,
    );

    await expect(
      service.adminSummary(principal, "org-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

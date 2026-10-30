import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  SimpleAdminOrderDetailSchema,
  SimpleAdminOrdersSchema,
  SimpleAdminTechniciansSchema,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SimpleAdminService } from "./simple-admin.service.js";

const createdAt = new Date("2026-10-31T00:00:00.000Z");
const principal = (
  role: UserRole = "OPERATOR",
  org = "org-a",
): AuthPrincipal => ({
  sessionId: "test-session",
  userId: "test-operator",
  displayName: "运营",
  memberships: [{ organizationId: org, role }],
  authChannel: "ADMIN_BROWSER",
  staffVerificationMethod: "PASSWORD_SMS",
  staffVerifiedUntil: new Date(Date.now() + 60_000),
  mfaVerifiedUntil: null,
});
function fixture() {
  const technician = {
    id: "profile-1",
    technicianId: "technician-1",
    publicName: "公开称呼",
    realNameEncrypted: "encrypted-real-name",
    status: "PENDING_REVIEW",
    version: 3,
    technician: {
      displayName: "账号昵称",
      phoneEncrypted: "encrypted-phone",
      phoneVerifiedAt: createdAt,
    },
  };
  const order = {
    id: "order-1",
    orderNo: "ORDER001",
    customer: { displayName: "客户昵称" },
    appointmentStart: createdAt,
    appointmentEnd: new Date(createdAt.getTime() + 60 * 60_000),
    status: "PAID",
    createdAt,
    serviceAmountFen: 21800n,
    travelFeeFen: 0n,
    discountFen: 1000n,
    payableFen: 20800n,
    therapist: {
      displayName: "技师昵称",
      technicianProfile: { publicName: "技师称呼" },
    },
    items: [
      {
        serviceName: "中式推拿",
        durationMinutes: 60,
        unitPriceFen: 21800n,
        quantity: 1,
      },
    ],
  };
  const prisma = {
    technicianProfile: { findMany: vi.fn().mockResolvedValue([technician]) },
    technicianIntakeApplication: { findMany: vi.fn().mockResolvedValue([]) },
    order: {
      findMany: vi.fn().mockResolvedValue([order]),
      findFirst: vi.fn().mockResolvedValue(order),
    },
  };
  const access = new AccessControlService({ get: () => "production" } as never);
  const crypto = {
    decrypt: vi.fn().mockReturnValue("13800138000"),
    decryptScoped: vi.fn().mockReturnValue("真实姓名"),
  };
  const customers = {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  return {
    prisma,
    access,
    crypto,
    technician,
    order,
    customers,
    service: new SimpleAdminService(
      prisma as never,
      access,
      crypto as never,
      customers as never,
    ),
  };
}
describe("simple administrator read-only pages", () => {
  it("lists organization pending technicians with current versions and masked phones, never substituting identity pictures for certificates", async () => {
    const f = fixture();
    const result = SimpleAdminTechniciansSchema.parse(
      await f.service.technicians(principal(), "org-a", {
        limit: 20,
        status: "PENDING_REVIEW",
      }),
    );
    expect(result.items[0]).toEqual({
      technicianId: "technician-1",
      source: "LEGACY_PROFILE",
      name: "真实姓名",
      maskedPhone: "138****8000",
      phoneVerified: true,
      version: 3,
      status: "PENDING_REVIEW",
      certificatePhotos: [],
      certificatePhotoStatus: "NOT_UPLOADED",
    });
    expect(f.prisma.technicianProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-a",
          registrationChannel: { not: "ADMIN_PHOTO_DRAFT" },
          technician: { status: "ACTIVE" },
          status: "PENDING_REVIEW",
        },
        take: 21,
      }),
    );
    expect(f.crypto.decryptScoped).toHaveBeenCalledWith(
      "technician-real-name:profile-1",
      "encrypted-real-name",
    );
    expect(JSON.stringify(result)).not.toContain("encrypted");
    expect(JSON.stringify(result)).not.toContain("13800138000");
  });
  it("uses a bounded stable profile cursor and retains a null phone for unreadable fields", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findMany.mockResolvedValue([
      f.technician,
      { ...f.technician, id: "profile-2" },
    ]);
    f.crypto.decrypt.mockImplementation(() => {
      throw new Error("private error");
    });
    f.crypto.decryptScoped.mockImplementation(() => {
      throw new Error("private error");
    });
    const result = await f.service.technicians(principal(), "org-a", {
      limit: 1,
      cursor: "profile-0",
      status: "ALL",
    });
    expect(result.nextCursor).toBe("L_profile-1");
    expect(result.items[0]).toMatchObject({
      name: "公开称呼",
      maskedPhone: null,
    });
    expect(f.prisma.technicianProfile.findMany.mock.calls[0]![0]).toMatchObject(
      { where: { id: { gt: "profile-0" } }, take: 2 },
    );
  });
  it("merges private one-way intake and legacy records with a bounded source cursor, without querying images or creating accounts", async () => {
    const f = fixture();
    f.prisma.technicianIntakeApplication.findMany.mockResolvedValue([
      {
        id: "intake-1",
        nameEncrypted: "name",
        phoneEncrypted: "phone",
        status: "PENDING_REVIEW",
        version: 1,
      },
      {
        id: "intake-2",
        nameEncrypted: "name",
        phoneEncrypted: "phone",
        status: "PENDING_REVIEW",
        version: 1,
      },
    ] as never);
    f.crypto.decryptScoped.mockImplementation((purpose: string) =>
      purpose.endsWith(":phone") ? "13900139000" : "申请姓名",
    );
    const result = SimpleAdminTechniciansSchema.parse(
      await f.service.technicians(principal(), "org-a", {
        limit: 1,
        status: "PENDING_REVIEW",
      }),
    );
    expect(result.items[0]).toMatchObject({
      technicianId: "intake-1",
      source: "SIMPLE_INTAKE",
      phoneVerified: false,
      maskedPhone: "139****9000",
      certificatePhotoStatus: "AVAILABLE",
      certificatePhotos: [
        {
          id: "intake-1",
          url: "/admin/organizations/org-a/simple/intakes/intake-1/certificate",
        },
      ],
    });
    expect(result.nextCursor).toBe("I_intake-1");
    expect(
      f.prisma.technicianIntakeApplication.findMany.mock.calls[0]![0],
    ).toMatchObject({
      where: { organizationId: "org-a", status: "PENDING_REVIEW" },
      take: 2,
    });
    expect(
      f.prisma.technicianIntakeApplication.findMany.mock.calls[0]![0].select,
    ).not.toHaveProperty("certificateEncrypted");
    await f.service.technicians(principal(), "org-a", {
      limit: 1,
      status: "PENDING_REVIEW",
      cursor: "I_intake-1",
    });
    expect(
      f.prisma.technicianIntakeApplication.findMany.mock.calls[1]![0],
    ).toMatchObject({ where: { id: { gt: "intake-1" } } });
    await f.service.technicians(principal(), "org-a", {
      limit: 1,
      status: "PENDING_REVIEW",
      cursor: "L_profile-1",
    });
    expect(f.prisma.technicianIntakeApplication.findMany).toHaveBeenCalledTimes(
      2,
    );
  });
  it("allows the existing OPERATOR to read orders without dispatch or scheduling permission", async () => {
    const f = fixture();
    expect(f.access.hasPermission(principal(), "schedule.read", "org-a")).toBe(
      false,
    );
    const result = SimpleAdminOrdersSchema.parse(
      await f.service.orders(principal(), "org-a", {
        limit: 20,
        status: "ALL",
      }),
    );
    expect(result.items[0]).toEqual({
      id: "order-1",
      orderNo: "ORDER001",
      customerNickname: "客户昵称",
      appointmentStart: createdAt.toISOString(),
      status: "PAID",
    });
    expect(f.prisma.order.findMany.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: "org-a" },
      take: 21,
    });
  });
  it("reads only exact organization order details and serializes money without address or contact data", async () => {
    const f = fixture();
    const detail = SimpleAdminOrderDetailSchema.parse(
      await f.service.orderDetail(principal(), "org-a", "order-1"),
    );
    expect(f.prisma.order.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: "order-1", organizationId: "org-a" },
    });
    expect(detail).toMatchObject({
      payableFen: 20800,
      technicianName: "技师称呼",
      items: [{ unitPriceFen: 21800 }],
    });
    expect(
      f.prisma.order.findFirst.mock.calls[0]![0].select,
    ).not.toHaveProperty("addressEncrypted");
    expect(detail).not.toHaveProperty("phone");
    f.prisma.order.findFirst.mockResolvedValueOnce(null);
    await expect(
      f.service.orderDetail(principal(), "org-a", "foreign-order"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it("rejects unsafe bigint serialization instead of rounding money", async () => {
    const f = fixture();
    f.prisma.order.findFirst.mockResolvedValue({
      ...f.order,
      payableFen: 9007199254740992n,
    });
    await expect(
      f.service.orderDetail(principal(), "org-a", "order-1"),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
  it("retains customer-directory scope and does not invent an unscoped users query", async () => {
    const f = fixture();
    await f.service.users(principal(), "org-a", { limit: 20 });
    expect(f.customers.list).toHaveBeenCalledWith(principal(), "org-a", {
      limit: 20,
    });
  });
  it.each(["CUSTOMER", "THERAPIST"] as UserRole[])(
    "denies %s and cross-tenant readers before data access",
    async (role) => {
      const f = fixture();
      for (const actor of [principal(role), principal("OPERATOR", "org-b")]) {
        await expect(
          f.service.orders(actor, "org-a", { limit: 20, status: "ALL" }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          f.service.technicians(actor, "org-a", { limit: 20, status: "ALL" }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(() => f.service.users(actor, "org-a", { limit: 20 })).toThrow(
          ForbiddenException,
        );
      }
      expect(f.prisma.order.findMany).not.toHaveBeenCalled();
      expect(f.prisma.technicianProfile.findMany).not.toHaveBeenCalled();
      expect(f.customers.list).not.toHaveBeenCalled();
    },
  );
  it("does not allow customer or technician SMS sessions even with forged staff claims", async () => {
    const f = fixture();
    for (const authChannel of ["CUSTOMER_SMS", "TECHNICIAN_PHONE"]) {
      const actor = { ...principal(), authChannel };
      await expect(
        f.service.orders(actor, "org-a", { limit: 20, status: "ALL" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        f.service.orderDetail(actor, "org-a", "order-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(f.prisma.order.findMany).not.toHaveBeenCalled();
    expect(f.prisma.order.findFirst).not.toHaveBeenCalled();
  });
});

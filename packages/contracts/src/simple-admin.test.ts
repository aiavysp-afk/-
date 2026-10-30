import { describe, expect, it } from "vitest";
import {
  SimpleAdminTechniciansQuerySchema,
  SimpleAdminOrdersQuerySchema,
  SimpleAdminTechniciansSchema,
  SimpleAdminOrderDetailSchema,
} from "./index.js";

describe("simple admin contracts", () => {
  it("defaults technicians to pending review and keeps pagination bounded", () => {
    expect(SimpleAdminTechniciansQuerySchema.parse({})).toEqual({
      limit: 20,
      status: "PENDING_REVIEW",
    });
    expect(SimpleAdminOrdersQuerySchema.parse({})).toEqual({
      limit: 20,
      status: "ALL",
    });
    expect(SimpleAdminOrdersQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      SimpleAdminOrdersQuerySchema.safeParse({ status: "INVALID" }).success,
    ).toBe(false);
    expect(
      SimpleAdminOrdersQuerySchema.safeParse({ organizationId: "forged" })
        .success,
    ).toBe(false);
  });
  it("accepts no certificate records and a masked verified phone without exposing private material", () => {
    const result = {
      items: [
        {
          technicianId: "tech",
          name: "姓名",
          maskedPhone: "138****8000",
          status: "PENDING_REVIEW",
          version: 1,
          certificatePhotos: [],
          certificatePhotoStatus: "NOT_UPLOADED",
        },
      ],
      nextCursor: null,
    };
    expect(SimpleAdminTechniciansSchema.safeParse(result).success).toBe(true);
    expect(
      SimpleAdminTechniciansSchema.safeParse({
        ...result,
        items: [{ ...result.items[0], maskedPhone: "13800138000" }],
      }).success,
    ).toBe(false);
    expect(
      SimpleAdminTechniciansSchema.safeParse({
        ...result,
        items: [
          {
            ...result.items[0],
            identityDocumentUrl: "https://example.invalid/identity.jpg",
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("does not accept addresses or phone fields in simplified order details", () => {
    const detail = {
      id: "order",
      orderNo: "ORDER001",
      customerNickname: "客户",
      appointmentStart: "2026-10-31T00:00:00.000Z",
      appointmentEnd: "2026-10-31T01:00:00.000Z",
      status: "PAID",
      serviceAmountFen: 21800,
      travelFeeFen: 0,
      discountFen: 1000,
      payableFen: 20800,
      createdAt: "2026-10-31T00:00:00.000Z",
      technicianName: null,
      items: [
        {
          serviceName: "中式推拿",
          durationMinutes: 60,
          unitPriceFen: 21800,
          quantity: 1,
        },
      ],
    };
    expect(SimpleAdminOrderDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      SimpleAdminOrderDetailSchema.safeParse({
        ...detail,
        phone: "13800138000",
      }).success,
    ).toBe(false);
    expect(
      SimpleAdminOrderDetailSchema.safeParse({
        ...detail,
        addressEncrypted: "private",
      }).success,
    ).toBe(false);
  });
});

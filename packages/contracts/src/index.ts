import { z } from "zod";

export const MoneyFenSchema = z.number().int().nonnegative();

export const ServiceCategorySchema = z.enum([
  "MASSAGE",
  "SPA_RELAXATION",
  "FOOT_CARE",
]);

export const ServiceItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: ServiceCategorySchema,
  subtitle: z.string(),
  description: z.string(),
  durationMinutes: z.number().int().positive(),
  priceFen: MoneyFenSchema,
  badge: z.string().optional(),
  featured: z.boolean(),
  steps: z.array(z.string()),
  boundaries: z.array(z.string()),
});

export const AdminServiceItemSchema = ServiceItemSchema.extend({
  organizationId: z.string(),
  published: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const ServiceAdminUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    category: ServiceCategorySchema.optional(),
    subtitle: z.string().trim().min(2).max(120).optional(),
    badge: z.string().trim().max(30).nullable().optional(),
    description: z.string().trim().min(10).max(2_000).optional(),
    durationMinutes: z.number().int().min(30).max(480).optional(),
    priceFen: MoneyFenSchema.max(100_000_000).optional(),
    featured: z.boolean().optional(),
    steps: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
    boundaries: z
      .array(z.string().trim().min(1).max(160))
      .min(1)
      .max(20)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可更新字段");

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const AvailabilityQuerySchema = z
  .object({
    serviceId: z.string().trim().min(1).max(128),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  })
  .strict();

export const AvailabilitySlotSchema = z.object({
  therapistId: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
});

export const ShiftCreateSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(128),
    therapistId: z.string().trim().min(1).max(128),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
  })
  .strict()
  .refine(
    (value) => Date.parse(value.startsAt) < Date.parse(value.endsAt),
    "排班结束时间必须晚于开始时间",
  );

export const BookingHoldCreateSchema = z
  .object({
    serviceId: z.string().trim().min(1).max(128),
    therapistId: z.string().trim().min(1).max(128),
    startsAt: IsoDateTimeSchema,
  })
  .strict();

export const BookingHoldSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  therapistId: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  status: z.literal("HOLD"),
});

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const ServiceAddressSchema = z
  .object({
    contactName: z.string().trim().min(2).max(40),
    phone: z
      .string()
      .trim()
      .regex(/^1\d{10}$/),
    detail: z.string().trim().min(5).max(200),
  })
  .strict();

export const OrderQuoteRequestSchema = z
  .object({ reservationId: z.string().trim().min(1).max(128) })
  .strict();

export const OrderCreateSchema = z
  .object({
    reservationId: z.string().trim().min(1).max(128),
    address: ServiceAddressSchema,
  })
  .strict();

export const OrderStatusSchema = z.enum([
  "PENDING_PAYMENT",
  "PAID",
  "DISPATCHING",
  "ASSIGNED",
  "EN_ROUTE",
  "ARRIVED",
  "IN_SERVICE",
  "AWAITING_CONFIRMATION",
  "COMPLETED",
  "CANCELLED",
  "REFUNDING",
  "REFUNDED",
]);

export const OrderQuoteSchema = z.object({
  reservationId: z.string(),
  serviceAmountFen: MoneyFenSchema,
  travelFeeFen: MoneyFenSchema,
  discountFen: MoneyFenSchema,
  payableFen: MoneyFenSchema,
  currency: z.literal("CNY"),
  moneyUnit: z.literal("fen"),
});

export const OrderViewSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  reservationId: z.string(),
  status: OrderStatusSchema,
  serviceName: z.string(),
  appointmentStart: IsoDateTimeSchema,
  appointmentEnd: IsoDateTimeSchema,
  serviceAmountFen: MoneyFenSchema,
  travelFeeFen: MoneyFenSchema,
  discountFen: MoneyFenSchema,
  payableFen: MoneyFenSchema,
  paymentExpiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const PaymentProviderSchema = z.enum(["MOCK", "WECHAT"]);
export const PaymentStatusSchema = z.enum([
  "PENDING",
  "SUCCEEDED",
  "CLOSED",
  "FAILED",
  "REFUNDING",
  "REFUNDED",
]);

export const WechatPayParametersSchema = z.object({
  timeStamp: z.string().regex(/^\d+$/),
  nonceStr: z.string().min(1).max(32),
  package: z.string().regex(/^prepay_id=[A-Za-z0-9_-]{1,64}$/),
  signType: z.literal("RSA"),
  paySign: z.string().min(1),
});

export const PaymentIntentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  provider: PaymentProviderSchema,
  status: PaymentStatusSchema,
  amountFen: MoneyFenSchema,
  expiresAt: IsoDateTimeSchema,
  mockConfirmationAvailable: z.boolean(),
  prepayState: z.enum(["NONE", "DISPATCHING", "READY", "UNKNOWN"]).optional(),
  wechatPayParameters: WechatPayParametersSchema.optional(),
});

export const WecomCustomerServiceUrlSchema = z
  .string()
  .regex(
    /^https:\/\/work\.weixin\.qq\.com\/(?:kfid|kf)\/[A-Za-z0-9_-]{5,128}(?:\?enc_scene=[A-Za-z0-9%_=-]{1,256})?$/,
  );
export const WecomCorpIdSchema = z.string().regex(/^ww[A-Za-z0-9]{16}$/);
export const PublicConfigSchema = z.object({
  brandName: z.string(),
  miniappAppId: z.string(),
  officialAccountId: z.string(),
  operatingMode: z.enum(["DEVELOPMENT", "PILOT", "PRODUCTION"]),
  serviceCity: z.string(),
  safetyHotlineAvailable: z.boolean(),
  emergencyContact: z
    .object({ phone: z.string(), configured: z.boolean() })
    .optional(),
  customerService: z
    .object({
      provider: z.enum(["none", "wecom"]),
      available: z.boolean(),
      url: z.union([z.literal(""), WecomCustomerServiceUrlSchema]),
      corpId: z.union([z.literal(""), WecomCorpIdSchema]),
    })
    .optional(),
  safetyContact: z
    .object({
      mode: z.enum(["phone", "wecom"]),
      available: z.boolean(),
      dutyConfirmed: z.boolean(),
    })
    .optional(),
  integrations: z.object({
    payment: z.enum(["mock", "wechat"]),
    sms: z.enum(["mock", "aliyun"]),
    map: z.enum(["mock", "tencent"]),
  }),
});

export const RefundReasonSchema = z.enum([
  "CUSTOMER_CANCELLED",
  "UNFULFILLABLE",
  "LATE_PAYMENT",
]);
export const RefundRequestSchema = z
  .object({ reason: RefundReasonSchema })
  .strict();
export const RefundReviewSchema = z
  .object({
    code: z.enum([
      "CONFIRMED",
      "INSUFFICIENT_EVIDENCE",
      "DUPLICATE_REQUEST",
      "POLICY_REVIEW_REQUIRED",
    ]),
  })
  .strict();
export const RefundStatusSchema = z.enum([
  "REQUESTED",
  "APPROVED",
  "PROCESSING",
  "UNKNOWN",
  "ABNORMAL",
  "CLOSED",
  "SUCCEEDED",
  "REJECTED",
]);
export const RefundViewSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  orderId: z.string(),
  amountFen: MoneyFenSchema,
  status: RefundStatusSchema,
  reason: RefundReasonSchema,
  policyVersion: z.string(),
  requestedAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema.nullable(),
  submittedAt: IsoDateTimeSchema.nullable(),
  succeededAt: IsoDateTimeSchema.nullable(),
});

export const SafetyDutyRosterUpsertSchema = z
  .object({
    primaryUserId: z.string().min(1).max(128),
    backupUserId: z.string().min(1).max(128),
    acknowledgementTimeoutSeconds: z.number().int().min(60).max(900),
  })
  .strict()
  .refine((value) => value.primaryUserId !== value.backupUserId, {
    message: "主备值班人员必须分离",
  });
export const SafetyDutyRosterViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  primaryUserId: z.string(),
  backupUserId: z.string(),
  acknowledgementTimeoutSeconds: z.number().int().min(60).max(900),
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export const SafetyDutyStaffViewSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
});

export const SafetyIncidentCategorySchema = z.enum([
  "PERSONAL_SAFETY",
  "MEDICAL_CONCERN",
  "SERVICE_DISPUTE",
  "OTHER_URGENT",
]);
export const SafetyIncidentStatusSchema = z.enum([
  "OPEN",
  "ESCALATED",
  "ACKNOWLEDGED",
  "CLOSED",
]);
export const SafetyIncidentCreateSchema = z
  .object({ category: SafetyIncidentCategorySchema })
  .strict();
export const SafetyIncidentCloseSchema = z
  .object({
    resolutionCode: z.enum([
      "RESOLVED",
      "REFERRED_PUBLIC_EMERGENCY",
      "FALSE_ALARM",
      "FOLLOW_UP_REQUIRED",
    ]),
  })
  .strict();
export const SafetyIncidentViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  orderId: z.string(),
  category: SafetyIncidentCategorySchema,
  status: SafetyIncidentStatusSchema,
  primaryUserId: z.string(),
  backupUserId: z.string(),
  acknowledgementDueAt: IsoDateTimeSchema,
  acknowledgedById: z.string().nullable(),
  acknowledgedAt: IsoDateTimeSchema.nullable(),
  escalatedAt: IsoDateTimeSchema.nullable(),
  resolutionCode: z.string().nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export const SafetyIncidentCustomerViewSchema = SafetyIncidentViewSchema.omit({
  primaryUserId: true,
  backupUserId: true,
});

export const WechatMiniappLoginRequestSchema = z.object({
  code: z.string().trim().min(1).max(128),
});

export const UserRoleSchema = z.enum([
  "CUSTOMER",
  "THERAPIST",
  "OPERATOR",
  "DISPATCHER",
  "FINANCE_REQUESTER",
  "FINANCE_APPROVER",
  "SAFETY_DUTY",
  "ADMIN",
]);

export const AuthMembershipSchema = z.object({
  organizationId: z.string(),
  role: UserRoleSchema,
});

export const AuthUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  memberships: z.array(AuthMembershipSchema),
});

export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  user: AuthUserSchema,
});

export const MfaRecoveryStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);
export const MfaRecoveryRejectionCodeSchema = z.enum([
  "IDENTITY_NOT_CONFIRMED",
  "REQUEST_NOT_EXPECTED",
  "POLICY_REVIEW_REQUIRED",
]);
export const MfaRecoveryRequestSchema = z
  .object({ organizationId: z.string().min(1).max(128) })
  .strict();
export const MfaRecoveryRejectSchema = z
  .object({ reasonCode: MfaRecoveryRejectionCodeSchema })
  .strict();
export const MfaRecoveryViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string().nullable(),
  targetUserId: z.string(),
  targetDisplayName: z.string().nullable(),
  status: MfaRecoveryStatusSchema,
  reasonCode: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema.nullable(),
  executedAt: IsoDateTimeSchema.nullable(),
  revokedSessions: z.number().int().nonnegative().optional(),
});

export type ServiceItem = z.infer<typeof ServiceItemSchema>;
export type AdminServiceItem = z.infer<typeof AdminServiceItemSchema>;
export type ServiceAdminUpdate = z.infer<typeof ServiceAdminUpdateSchema>;
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
export type ShiftCreate = z.infer<typeof ShiftCreateSchema>;
export type BookingHoldCreate = z.infer<typeof BookingHoldCreateSchema>;
export type BookingHold = z.infer<typeof BookingHoldSchema>;
export type ServiceAddress = z.infer<typeof ServiceAddressSchema>;
export type OrderQuoteRequest = z.infer<typeof OrderQuoteRequestSchema>;
export type OrderCreate = z.infer<typeof OrderCreateSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type OrderQuote = z.infer<typeof OrderQuoteSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;
export type WechatPayParameters = z.infer<typeof WechatPayParametersSchema>;
export type RefundRequest = z.infer<typeof RefundRequestSchema>;
export type RefundReview = z.infer<typeof RefundReviewSchema>;
export type RefundView = z.infer<typeof RefundViewSchema>;
export type SafetyDutyRosterUpsert = z.infer<
  typeof SafetyDutyRosterUpsertSchema
>;
export type SafetyDutyRosterView = z.infer<typeof SafetyDutyRosterViewSchema>;
export type SafetyDutyStaffView = z.infer<typeof SafetyDutyStaffViewSchema>;
export type SafetyIncidentCreate = z.infer<typeof SafetyIncidentCreateSchema>;
export type SafetyIncidentClose = z.infer<typeof SafetyIncidentCloseSchema>;
export type SafetyIncidentView = z.infer<typeof SafetyIncidentViewSchema>;
export type SafetyIncidentCustomerView = z.infer<
  typeof SafetyIncidentCustomerViewSchema
>;
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export type WechatMiniappLoginRequest = z.infer<
  typeof WechatMiniappLoginRequestSchema
>;
export type MfaRecoveryStatus = z.infer<typeof MfaRecoveryStatusSchema>;
export type MfaRecoveryRejectionCode = z.infer<
  typeof MfaRecoveryRejectionCodeSchema
>;
export type MfaRecoveryView = z.infer<typeof MfaRecoveryViewSchema>;
export type AuthMembership = z.infer<typeof AuthMembershipSchema>;
export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const formatMoney = (fen: number): string =>
  `¥${(fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)}`;

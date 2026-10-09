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

export const Gcj02CoordinateSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    coordinateSystem: z.literal("GCJ-02"),
  })
  .strict();

export const ServiceAddressSchema = z
  .object({
    contactName: z.string().trim().min(2).max(40),
    phone: z
      .string()
      .trim()
      .regex(/^1\d{10}$/),
    detail: z.string().trim().min(5).max(200),
    latitude: Gcj02CoordinateSchema.shape.latitude,
    longitude: Gcj02CoordinateSchema.shape.longitude,
    coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem,
  })
  .strict();

export const AddressSuggestionQuerySchema = z
  .object({
    keyword: z.string().trim().min(2).max(32),
  })
  .strict();

export const ManualAddressGeocodeSchema = z
  .object({
    detail: z.string().trim().min(5).max(200),
  })
  .strict();

export const GeocodedAddressSchema = z.object({
  detail: z.string().min(1).max(300),
  adcode: z.string().regex(/^\d{6}$/),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  coordinateSystem: z.literal("GCJ-02"),
});

export const AddressSuggestionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  address: z.string().max(300),
  city: z.string().min(1).max(64),
  adcode: z.string().regex(/^\d{6}$/),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  coordinateSystem: z.literal("GCJ-02"),
});

export const AddressVerificationCreateSchema = z
  .object({
    reservationId: z.string().trim().min(1).max(128),
    detail: z.string().trim().min(5).max(200),
    latitude: Gcj02CoordinateSchema.shape.latitude,
    longitude: Gcj02CoordinateSchema.shape.longitude,
    coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem,
  })
  .strict();

export const AddressVerificationSchema = z.object({
  id: z.string(),
  reservationId: z.string(),
  adcode: z.string().regex(/^\d{6}$/),
  latitude: Gcj02CoordinateSchema.shape.latitude,
  longitude: Gcj02CoordinateSchema.shape.longitude,
  coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem,
  expiresAt: IsoDateTimeSchema,
});

export const OrderQuoteRequestSchema = z
  .object({
    reservationId: z.string().trim().min(1).max(128),
    couponId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();

export const OrderCreateSchema = z
  .object({
    reservationId: z.string().trim().min(1).max(128),
    address: ServiceAddressSchema,
    addressVerificationId: z.string().trim().min(1).max(128).optional(),
    couponId: z.string().trim().min(1).max(128).nullable().optional(),
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

export const TechnicianReviewStatusSchema = z.enum([
  "PENDING_REVIEW",
  "PUBLISHED",
  "HIDDEN",
]);

export const OrderQuoteSchema = z.object({
  reservationId: z.string(),
  couponId: z.string().nullable().optional(),
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
  reviewStatus: TechnicianReviewStatusSchema.nullable(),
  paymentExpiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const OperationsDashboardOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  customerName: z.string(),
  serviceName: z.string(),
  appointmentStart: IsoDateTimeSchema,
  therapistName: z.string().nullable(),
  status: OrderStatusSchema,
  payableFen: MoneyFenSchema,
});

export const OperationsDashboardSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.literal("Asia/Shanghai"),
  generatedAt: IsoDateTimeSchema,
  metrics: z.object({
    todayOrders: z.number().int().nonnegative(),
    activeOrders: z.number().int().nonnegative(),
    paidTodayFen: MoneyFenSchema,
    attentionRequired: z.number().int().nonnegative(),
  }),
  recentOrders: z.array(OperationsDashboardOrderSchema),
});

export const TechnicianWorkbenchOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  serviceName: z.string(),
  durationMinutes: z.number().int().positive(),
  appointmentStart: IsoDateTimeSchema,
  appointmentEnd: IsoDateTimeSchema,
  status: OrderStatusSchema,
  destination: Gcj02CoordinateSchema.extend({
    addressLabel: z.string().min(5).max(200),
  }).nullable(),
});

export const TechnicianLocationReportSchema = Gcj02CoordinateSchema.extend({
  accuracyMeters: z.number().finite().nonnegative().max(10_000).optional(),
});

export const TechnicianLocationReportResultSchema =
  TechnicianLocationReportSchema.extend({
    reportedAt: IsoDateTimeSchema,
  });

export const TechnicianRouteSchema = z.object({
  orderId: z.string(),
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  origin: Gcj02CoordinateSchema,
  destination: Gcj02CoordinateSchema.extend({
    addressLabel: z.string().min(5).max(200),
  }),
});

export const CustomerTechnicianLocationSchema = z.object({
  orderId: z.string(),
  status: z.enum(["UNASSIGNED", "HIDDEN", "UNAVAILABLE", "STALE", "AVAILABLE"]),
  location: TechnicianLocationReportResultSchema.nullable(),
});

export const TechnicianWorkbenchShiftSchema = z.object({
  id: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  status: z.enum(["ACTIVE", "CANCELLED"]),
});

export const TechnicianWorkbenchSchema = z.object({
  displayName: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.literal("Asia/Shanghai"),
  generatedAt: IsoDateTimeSchema,
  metrics: z.object({
    todayOrders: z.number().int().nonnegative(),
    activeOrders: z.number().int().nonnegative(),
    completedOrders: z.number().int().nonnegative(),
    weeklyShifts: z.number().int().nonnegative(),
  }),
  orders: z.array(TechnicianWorkbenchOrderSchema),
  shifts: z.array(TechnicianWorkbenchShiftSchema),
});

export const TechnicianEarningsItemSchema = z.object({
  orderId: z.string(),
  orderNo: z.string(),
  serviceName: z.string(),
  completedAt: IsoDateTimeSchema,
  grossOrderAmountFen: MoneyFenSchema,
});

export const TechnicianEarningsSchema = z.object({
  periodStart: IsoDateTimeSchema,
  periodEnd: IsoDateTimeSchema,
  timeZone: z.literal("Asia/Shanghai"),
  generatedAt: IsoDateTimeSchema,
  metrics: z.object({
    completedOrders: z.number().int().nonnegative(),
    grossOrderAmountFen: MoneyFenSchema,
  }),
  settlement: z.object({
    status: z.literal("POLICY_NOT_CONFIGURED"),
    payableFen: z.null(),
    notice: z.string(),
  }),
  items: z.array(TechnicianEarningsItemSchema),
});

export const TechnicianOrderActionSchema = z
  .object({
    action: z.enum([
      "ACCEPT",
      "DEPART",
      "ARRIVE",
      "START_SERVICE",
      "FINISH_SERVICE",
    ]),
  })
  .strict();

export const TechnicianOrderActionResultSchema = z.object({
  orderId: z.string(),
  action: TechnicianOrderActionSchema.shape.action,
  previousStatus: OrderStatusSchema,
  status: OrderStatusSchema,
  idempotentReplay: z.boolean(),
});

export const CustomerOrderConfirmationSchema = z.object({}).strict();

export const CustomerOrderConfirmationResultSchema = z.object({
  orderId: z.string(),
  previousStatus: OrderStatusSchema,
  status: z.literal("COMPLETED"),
  idempotentReplay: z.boolean(),
});

export const DispatchTherapistSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

export const DispatchOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  customerName: z.string(),
  serviceName: z.string(),
  durationMinutes: z.number().int().positive(),
  appointmentStart: IsoDateTimeSchema,
  appointmentEnd: IsoDateTimeSchema,
  status: OrderStatusSchema,
  payableFen: MoneyFenSchema,
  therapist: DispatchTherapistSchema.nullable(),
  eligibleTherapists: z.array(DispatchTherapistSchema),
});

export const DispatchBoardSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  timeZone: z.literal("Asia/Shanghai"),
  orders: z.array(DispatchOrderSchema),
});

export const DispatchAssignmentSchema = z
  .object({
    therapistId: z.string().min(1).max(128),
  })
  .strict();

export const DispatchAssignmentResultSchema = z.object({
  orderId: z.string(),
  status: z.literal("ASSIGNED"),
  therapist: DispatchTherapistSchema,
});

export const AdminTechnicianShiftSchema = z.object({
  id: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  status: z.enum(["ACTIVE", "CANCELLED"]),
});

export const AdminTechnicianSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  accountStatus: z.string(),
  availability: z.enum(["ON_SHIFT", "SCHEDULED", "OFF_DUTY"]),
  todayShift: AdminTechnicianShiftSchema.nullable(),
  metrics: z.object({
    activeOrders: z.number().int().nonnegative(),
    completedToday: z.number().int().nonnegative(),
  }),
});

export const AdminTechnicianBoardSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.literal("Asia/Shanghai"),
  generatedAt: IsoDateTimeSchema,
  technicians: z.array(AdminTechnicianSchema),
});

export const TechnicianProfileStatusSchema = z.enum([
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
]);

export const TechnicianInvitationStatusSchema = z.enum([
  "PENDING",
  "CLAIMED",
  "REVOKED",
  "EXPIRED",
]);

export const TechnicianInvitationCreateSchema = z
  .object({
    publicName: z.string().trim().min(2).max(40),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })
  .strict();

export const TechnicianInvitationClaimSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{12}$/),
  })
  .strict();

export const TechnicianInvitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  publicName: z.string(),
  status: TechnicianInvitationStatusSchema,
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  claimedAt: IsoDateTimeSchema.nullable(),
  claimedDisplayName: z.string().nullable(),
});

export const TechnicianInvitationCreatedSchema = z.object({
  invitation: TechnicianInvitationSchema,
  code: z.string().regex(/^[A-Z0-9_-]{12}$/),
  miniappPath: z.string(),
});

export const TechnicianInvitationClaimedSchema = z.object({
  invitationId: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  publicName: z.string(),
  profileStatus: z.literal("DRAFT"),
  claimedAt: IsoDateTimeSchema,
});

const PublicHttpsUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"), "仅允许 HTTPS 资源地址");

export const TechnicianProfileUpdateSchema = z
  .object({
    publicName: z.string().trim().min(2).max(40).optional(),
    avatarUrl: PublicHttpsUrlSchema.nullable().optional(),
    galleryUrls: z.array(PublicHttpsUrlSchema).max(12).optional(),
    introduction: z.string().trim().max(2_000).optional(),
    specialties: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    serviceYears: z.number().int().min(0).max(60).nullable().optional(),
    certificates: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可更新字段");

export const TechnicianReviewCreateSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    content: z.string().trim().min(2).max(1_000),
  })
  .strict();

export const TechnicianReviewSchema = z.object({
  id: z.string(),
  technicianId: z.string(),
  customerAlias: z.string(),
  rating: z.number().int().min(1).max(5),
  content: z.string(),
  createdAt: IsoDateTimeSchema,
});

export const AdminTechnicianReviewSchema = TechnicianReviewSchema.extend({
  orderId: z.string(),
  status: TechnicianReviewStatusSchema,
  updatedAt: IsoDateTimeSchema,
});

export const TechnicianReviewSummarySchema = z.object({
  averageRating: z.number().min(1).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  completedOrders: z.number().int().nonnegative(),
});

export const TechnicianProfileSchema = z.object({
  technicianId: z.string(),
  displayName: z.string(),
  publicName: z.string(),
  avatarUrl: PublicHttpsUrlSchema.nullable(),
  galleryUrls: z.array(PublicHttpsUrlSchema),
  introduction: z.string(),
  specialties: z.array(z.string()),
  serviceYears: z.number().int().nonnegative().nullable(),
  certificates: z.array(z.string()),
  reviewSummary: TechnicianReviewSummarySchema,
  recentReviews: z.array(TechnicianReviewSchema),
  status: TechnicianProfileStatusSchema,
  rejectionReason: z.string().nullable(),
  freeTravelFee: z.literal(true),
  travelFeeFen: z.literal(0),
  updatedAt: IsoDateTimeSchema,
});

export const OrderHideResultSchema = z.object({
  orderId: z.string(),
  hiddenAt: IsoDateTimeSchema,
});

export const AdminShiftSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  therapistId: z.string(),
  therapistDisplayName: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  status: z.enum(["ACTIVE", "CANCELLED"]),
});

export const AdminServiceAreaSchema = z.object({
  serviceCity: z.string(),
  coveragePolicy: z.literal("ZHENGZHOU_FULL"),
  targetAdcodes: z.array(z.string().regex(/^\d{6}$/)),
  configuredAdcodes: z.array(z.string().regex(/^\d{6}$/)),
  fullyConfigured: z.boolean(),
  mapProvider: z.enum(["mock", "amap"]),
  verificationEnabled: z.boolean(),
  notice: z.string(),
});

export const AdminReadinessSchema = z.object({
  environment: z.enum(["development", "test", "production"]),
  generatedAt: IsoDateTimeSchema,
  auth: z.object({
    provider: z.enum(["mock", "wechat"]),
    staffMfaRequired: z.boolean(),
    browserLoginEnabled: z.boolean(),
  }),
  payment: z.object({
    provider: z.enum(["mock", "wechat"]),
    prepayEnabled: z.boolean(),
    recoveryEnabled: z.boolean(),
    refundEnabled: z.boolean(),
  }),
  map: z.object({
    provider: z.enum(["mock", "amap"]),
    geocodingEnabled: z.boolean(),
    coverageConfigured: z.boolean(),
  }),
  safety: z.object({
    smsProvider: z.enum(["none", "mock", "aliyun"]),
    smsSendEnabled: z.boolean(),
    dispatchEnabled: z.boolean(),
    receiptQueryEnabled: z.boolean(),
    dutyConfirmed: z.boolean(),
  }),
  customerService: z.object({
    provider: z.enum(["none", "wecom"]),
    ownershipConfirmed: z.boolean(),
  }),
});

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
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
    sms: z.enum(["none", "mock", "aliyun"]),
    map: z.enum(["mock", "amap"]),
  }),
  map: z.object({
    coordinateSystem: z.literal("GCJ-02"),
    miniappKey: z.string(),
  }),
  features: z.object({
    addressSuggestionAvailable: z.boolean(),
    addressVerificationRequired: z.boolean(),
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
  phoneConfigured: z.boolean(),
});
export const SafetyDutyContactUpdateSchema = z
  .object({ phone: z.string().regex(/^1[3-9]\d{9}$/) })
  .strict();
export const SafetyNotificationStateSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "DEAD_LETTER",
]);
export const SafetyNotificationDeliveryStatusSchema = z.enum([
  "PENDING",
  "DELIVERED",
  "FAILED",
  "UNKNOWN",
]);
export const SafetyNotificationViewSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  type: z.enum(["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"]),
  state: SafetyNotificationStateSchema,
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: IsoDateTimeSchema,
  lastErrorCode: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  publishedAt: IsoDateTimeSchema.nullable(),
  deadLetteredAt: IsoDateTimeSchema.nullable(),
  deliveryStatus: SafetyNotificationDeliveryStatusSchema.nullable(),
  deliveryQueryAttempts: z.number().int().nonnegative(),
  deliveryCheckedAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  deliveryErrorCode: z.string().nullable(),
});
export const SafetyNotificationSummarySchema = z.object({
  dispatchPending: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  awaitingReceipt: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  deliveryFailed: z.number().int().nonnegative(),
  deliveryUnknown: z.number().int().nonnegative(),
  oldestAttentionAt: IsoDateTimeSchema.nullable(),
  attentionRequired: z.boolean(),
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

export const WechatPhoneVerificationRequestSchema = z.object({
  code: z.string().trim().min(1).max(128),
});

export const WechatPhoneVerificationResultSchema = z.object({
  phoneVerified: z.literal(true),
  maskedPhone: z.string().regex(/^1\d{2}\*{4}\d{4}$/),
});

export const SmsPhoneVerificationRequestSchema = z
  .object({
    phone: z.string().regex(/^1[3-9]\d{9}$/),
  })
  .strict();

export const SmsPhoneVerificationConfirmSchema = z
  .object({
    phone: z.string().regex(/^1[3-9]\d{9}$/),
    code: z.string().regex(/^\d{4,6}$/),
  })
  .strict();

export const SmsPhoneVerificationRequestResultSchema = z.object({
  status: z.enum(["ACCEPTED", "UNKNOWN"]),
  expiresAt: IsoDateTimeSchema,
  retryAfterSeconds: z.number().int().positive(),
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
  phoneVerified: z.boolean(),
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

export const CustomerCenterOrganizationQuerySchema = z
  .object({ organizationId: z.string().trim().min(1).max(128).optional() })
  .strict();

export const CustomerCenterContentSchema = z.object({
  levelLabel: z.string().min(1).max(32),
  customerServicePhone: z.string().nullable(),
  cityNewsTitle: z.string().min(1).max(80),
  cityNewsContent: z.string().min(1).max(300),
  appBannerTitle: z.string().min(1).max(80),
  appBannerSubtitle: z.string().min(1).max(160),
  appDownloadUrl: z.string().url().startsWith("https://").nullable(),
  safeguardItems: z.array(z.string().min(1).max(80)).max(8),
  updatedAt: IsoDateTimeSchema.nullable(),
});

export const CustomerCenterConfigUpdateSchema = z
  .object({
    levelLabel: z.string().trim().min(1).max(32).optional(),
    customerServicePhone: z
      .string()
      .trim()
      .regex(/^(?:400\d{7}|0\d{2,3}-?\d{7,8}|1\d{10})$/)
      .nullable()
      .optional(),
    cityNewsTitle: z.string().trim().min(1).max(80).optional(),
    cityNewsContent: z.string().trim().min(1).max(300).optional(),
    appBannerTitle: z.string().trim().min(1).max(80).optional(),
    appBannerSubtitle: z.string().trim().min(1).max(160).optional(),
    appDownloadUrl: z
      .string()
      .url()
      .startsWith("https://")
      .nullable()
      .optional(),
    safeguardItems: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可更新字段");

export const CustomerCenterOrderCountsSchema = z.object({
  pendingPayment: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  pendingReview: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

export const CustomerCenterOverviewSchema = z.object({
  organizationId: z.string(),
  profile: z.object({
    userId: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().url().nullable(),
    levelLabel: z.string(),
    registeredAt: IsoDateTimeSchema,
    phoneVerified: z.boolean(),
  }),
  benefits: z.object({
    availableCouponCount: z.number().int().nonnegative(),
    availableCardCount: z.number().int().nonnegative(),
    maskedBalance: z.literal("****"),
  }),
  orders: CustomerCenterOrderCountsSchema,
  content: CustomerCenterContentSchema,
});

export const CustomerCouponStatusSchema = z.enum([
  "AVAILABLE",
  "USED",
  "EXPIRED",
]);
export const CustomerCouponQuerySchema =
  CustomerCenterOrganizationQuerySchema.extend({
    status: CustomerCouponStatusSchema.optional(),
  }).strict();
export const CustomerCouponSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  amountFen: MoneyFenSchema,
  minimumSpendFen: MoneyFenSchema,
  applicability: z.string(),
  canApplyToTravelFee: z.boolean(),
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  status: CustomerCouponStatusSchema,
  usedAt: IsoDateTimeSchema.nullable(),
});

export const NewcomerCouponOfferSchema = z.object({
  organizationId: z.string(),
  eligible: z.boolean(),
  claimed: z.boolean(),
  reason: z.string(),
  coupons: z.array(CustomerCouponSchema),
  idempotentReplay: z.boolean().optional(),
});

export const StoredValueCardStatusSchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
export const StoredValueCardTypeSchema = z.enum([
  "PHYSICAL",
  "DISCOUNT_93",
  "DISCOUNT_90",
]);
export const StoredValueCardQuerySchema =
  CustomerCenterOrganizationQuerySchema.extend({
    status: StoredValueCardStatusSchema.optional(),
    type: StoredValueCardTypeSchema.optional(),
  }).strict();
export const StoredValueCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: StoredValueCardTypeSchema,
  balanceFen: MoneyFenSchema,
  status: StoredValueCardStatusSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
});
export const CustomerWalletSchema = z.object({
  organizationId: z.string(),
  balanceFen: MoneyFenSchema,
  cards: z.array(StoredValueCardSchema),
  recharge: z.object({
    enabled: z.boolean(),
    reason: z.string(),
    plans: z.array(
      z.object({
        amountFen: MoneyFenSchema,
        label: z.string(),
      }),
    ),
    firstRechargeReward: z.object({
      enabled: z.boolean(),
      reason: z.string(),
      amountFen: MoneyFenSchema,
      status: z.enum(["LOCKED", "CLAIMABLE", "CLAIMED", "INELIGIBLE"]),
      claimedAt: IsoDateTimeSchema.nullable(),
    }),
  }),
  withdrawal: z.object({
    enabled: z.boolean(),
    minimumFen: MoneyFenSchema,
    stepFen: MoneyFenSchema,
    reviewRequired: z.boolean(),
    reason: z.string(),
  }),
  checkIn: z.object({
    enabled: z.boolean(),
    rewardUnit: z.literal("POINTS"),
    reason: z.string(),
  }),
});
export const StoredValueRechargeCreateSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(128).optional(),
    amountFen: z.union([
      z.literal(28_800),
      z.literal(59_900),
      z.literal(88_800),
      z.literal(119_800),
      z.literal(288_800),
    ]),
  })
  .strict();
export const StoredValueRechargeIntentSchema = z.object({
  id: z.string(),
  amountFen: MoneyFenSchema,
  status: z.enum(["PENDING", "SUCCEEDED", "UNKNOWN", "CLOSED"]),
  expiresAt: IsoDateTimeSchema,
  prepayState: z.enum(["NONE", "DISPATCHING", "READY", "UNKNOWN"]),
  wechatPayParameters: WechatPayParametersSchema.optional(),
});
export const FirstRechargeRewardClaimSchema = z.object({
  organizationId: z.string(),
  amountFen: MoneyFenSchema,
  balanceFen: MoneyFenSchema,
  claimedAt: IsoDateTimeSchema,
});
export const StoredValueTransactionSchema = z.object({
  id: z.string(),
  type: z.string(),
  changeFen: z.number().int(),
  balanceAfterFen: MoneyFenSchema,
  description: z.string(),
  occurredAt: IsoDateTimeSchema,
});

export const CustomerSettingsSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  maskedPhone: z.string().nullable(),
  phoneVerified: z.boolean(),
  registeredAt: IsoDateTimeSchema,
  customerServicePhone: z.string().nullable(),
});

export const CustomerAddressCreateSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(128).optional(),
    contactName: z.string().trim().min(2).max(40),
    phone: z
      .string()
      .trim()
      .regex(/^1\d{10}$/),
    detail: z.string().trim().min(5).max(200),
    latitude: Gcj02CoordinateSchema.shape.latitude,
    longitude: Gcj02CoordinateSchema.shape.longitude,
    coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem,
    isDefault: z.boolean().optional(),
  })
  .strict();

export const CustomerAddressUpdateSchema = z
  .object({
    contactName: z.string().trim().min(2).max(40).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^1\d{10}$/)
      .optional(),
    detail: z.string().trim().min(5).max(200).optional(),
    latitude: Gcj02CoordinateSchema.shape.latitude.optional(),
    longitude: Gcj02CoordinateSchema.shape.longitude.optional(),
    coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可更新字段")
  .refine((value) => {
    const coordinateFields = [
      value.latitude,
      value.longitude,
      value.coordinateSystem,
    ];
    const supplied = coordinateFields.filter(
      (item) => item !== undefined,
    ).length;
    return supplied === 0 || supplied === 3;
  }, "经纬度与坐标系必须同时更新");

export const CustomerAddressSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  contactName: z.string(),
  phone: z.string(),
  detail: z.string(),
  latitude: Gcj02CoordinateSchema.shape.latitude,
  longitude: Gcj02CoordinateSchema.shape.longitude,
  coordinateSystem: Gcj02CoordinateSchema.shape.coordinateSystem,
  isDefault: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CustomerFeedbackCreateSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(128).optional(),
    category: z.enum(["GENERAL", "COMPLAINT", "SERVICE_AFTERCARE"]),
    content: z.string().trim().min(10).max(2_000),
    contact: z.string().trim().min(3).max(120).nullable().optional(),
  })
  .strict();
export const CustomerFeedbackSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  category: z.string(),
  status: z.enum(["OPEN", "RESOLVED"]),
  createdAt: IsoDateTimeSchema,
});

export const AccountDeletionRequestCreateSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(128).optional(),
    reason: z.string().trim().max(500).nullable().optional(),
    acknowledgedRisk: z.literal(true),
  })
  .strict();
export const AccountDeletionRequestSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  status: z.enum(["PENDING", "CANCELLED", "COMPLETED"]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
});

export const AdminCustomerCenterSummarySchema = z.object({
  generatedAt: IsoDateTimeSchema,
  orders: CustomerCenterOrderCountsSchema,
  coupons: z.object({
    available: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
  wallet: z.object({
    customerCount: z.number().int().nonnegative(),
    totalBalanceFen: MoneyFenSchema,
    transactionCount: z.number().int().nonnegative(),
  }),
  feedback: z.object({
    open: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  accountDeletionRequests: z.object({
    pending: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export type ServiceItem = z.infer<typeof ServiceItemSchema>;
export type AdminServiceItem = z.infer<typeof AdminServiceItemSchema>;
export type ServiceAdminUpdate = z.infer<typeof ServiceAdminUpdateSchema>;
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
export type ShiftCreate = z.infer<typeof ShiftCreateSchema>;
export type BookingHoldCreate = z.infer<typeof BookingHoldCreateSchema>;
export type BookingHold = z.infer<typeof BookingHoldSchema>;
export type Gcj02Coordinate = z.infer<typeof Gcj02CoordinateSchema>;
export type ServiceAddress = z.infer<typeof ServiceAddressSchema>;
export type AddressSuggestion = z.infer<typeof AddressSuggestionSchema>;
export type GeocodedAddress = z.infer<typeof GeocodedAddressSchema>;
export type AddressVerification = z.infer<typeof AddressVerificationSchema>;
export type OrderQuoteRequest = z.infer<typeof OrderQuoteRequestSchema>;
export type OrderCreate = z.infer<typeof OrderCreateSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type OrderQuote = z.infer<typeof OrderQuoteSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type OperationsDashboard = z.infer<typeof OperationsDashboardSchema>;
export type OperationsDashboardOrder = z.infer<
  typeof OperationsDashboardOrderSchema
>;
export type TechnicianWorkbench = z.infer<typeof TechnicianWorkbenchSchema>;
export type TechnicianWorkbenchOrder = z.infer<
  typeof TechnicianWorkbenchOrderSchema
>;
export type TechnicianWorkbenchShift = z.infer<
  typeof TechnicianWorkbenchShiftSchema
>;
export type TechnicianLocationReport = z.infer<
  typeof TechnicianLocationReportSchema
>;
export type TechnicianLocationReportResult = z.infer<
  typeof TechnicianLocationReportResultSchema
>;
export type TechnicianRoute = z.infer<typeof TechnicianRouteSchema>;
export type CustomerTechnicianLocation = z.infer<
  typeof CustomerTechnicianLocationSchema
>;
export type TechnicianEarnings = z.infer<typeof TechnicianEarningsSchema>;
export type TechnicianEarningsItem = z.infer<
  typeof TechnicianEarningsItemSchema
>;
export type TechnicianOrderAction = z.infer<typeof TechnicianOrderActionSchema>;
export type TechnicianOrderActionResult = z.infer<
  typeof TechnicianOrderActionResultSchema
>;
export type CustomerOrderConfirmation = z.infer<
  typeof CustomerOrderConfirmationSchema
>;
export type CustomerOrderConfirmationResult = z.infer<
  typeof CustomerOrderConfirmationResultSchema
>;
export type DispatchTherapist = z.infer<typeof DispatchTherapistSchema>;
export type DispatchOrder = z.infer<typeof DispatchOrderSchema>;
export type DispatchBoard = z.infer<typeof DispatchBoardSchema>;
export type DispatchAssignment = z.infer<typeof DispatchAssignmentSchema>;
export type DispatchAssignmentResult = z.infer<
  typeof DispatchAssignmentResultSchema
>;
export type AdminTechnicianShift = z.infer<typeof AdminTechnicianShiftSchema>;
export type AdminTechnician = z.infer<typeof AdminTechnicianSchema>;
export type AdminTechnicianBoard = z.infer<typeof AdminTechnicianBoardSchema>;
export type TechnicianProfileStatus = z.infer<
  typeof TechnicianProfileStatusSchema
>;
export type TechnicianInvitationStatus = z.infer<
  typeof TechnicianInvitationStatusSchema
>;
export type TechnicianInvitationCreate = z.infer<
  typeof TechnicianInvitationCreateSchema
>;
export type TechnicianInvitationClaim = z.infer<
  typeof TechnicianInvitationClaimSchema
>;
export type TechnicianInvitation = z.infer<typeof TechnicianInvitationSchema>;
export type TechnicianInvitationCreated = z.infer<
  typeof TechnicianInvitationCreatedSchema
>;
export type TechnicianInvitationClaimed = z.infer<
  typeof TechnicianInvitationClaimedSchema
>;
export type TechnicianProfileUpdate = z.infer<
  typeof TechnicianProfileUpdateSchema
>;
export type TechnicianReviewCreate = z.infer<
  typeof TechnicianReviewCreateSchema
>;
export type TechnicianReviewStatus = z.infer<
  typeof TechnicianReviewStatusSchema
>;
export type TechnicianReview = z.infer<typeof TechnicianReviewSchema>;
export type AdminTechnicianReview = z.infer<typeof AdminTechnicianReviewSchema>;
export type TechnicianReviewSummary = z.infer<
  typeof TechnicianReviewSummarySchema
>;
export type TechnicianProfile = z.infer<typeof TechnicianProfileSchema>;
export type OrderHideResult = z.infer<typeof OrderHideResultSchema>;
export type AdminShift = z.infer<typeof AdminShiftSchema>;
export type AdminServiceArea = z.infer<typeof AdminServiceAreaSchema>;
export type AdminReadiness = z.infer<typeof AdminReadinessSchema>;
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
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
export type SafetyDutyContactUpdate = z.infer<
  typeof SafetyDutyContactUpdateSchema
>;
export type SafetyNotificationState = z.infer<
  typeof SafetyNotificationStateSchema
>;
export type SafetyNotificationView = z.infer<
  typeof SafetyNotificationViewSchema
>;
export type SafetyNotificationSummary = z.infer<
  typeof SafetyNotificationSummarySchema
>;
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
export type WechatPhoneVerificationRequest = z.infer<
  typeof WechatPhoneVerificationRequestSchema
>;
export type WechatPhoneVerificationResult = z.infer<
  typeof WechatPhoneVerificationResultSchema
>;
export type SmsPhoneVerificationRequest = z.infer<
  typeof SmsPhoneVerificationRequestSchema
>;
export type SmsPhoneVerificationConfirm = z.infer<
  typeof SmsPhoneVerificationConfirmSchema
>;
export type SmsPhoneVerificationRequestResult = z.infer<
  typeof SmsPhoneVerificationRequestResultSchema
>;
export type MfaRecoveryStatus = z.infer<typeof MfaRecoveryStatusSchema>;
export type MfaRecoveryRejectionCode = z.infer<
  typeof MfaRecoveryRejectionCodeSchema
>;
export type MfaRecoveryView = z.infer<typeof MfaRecoveryViewSchema>;
export type AuthMembership = z.infer<typeof AuthMembershipSchema>;
export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type CustomerCenterContent = z.infer<typeof CustomerCenterContentSchema>;
export type CustomerCenterConfigUpdate = z.infer<
  typeof CustomerCenterConfigUpdateSchema
>;
export type CustomerCenterOrderCounts = z.infer<
  typeof CustomerCenterOrderCountsSchema
>;
export type CustomerCenterOverview = z.infer<
  typeof CustomerCenterOverviewSchema
>;
export type CustomerCouponStatus = z.infer<typeof CustomerCouponStatusSchema>;
export type CustomerCoupon = z.infer<typeof CustomerCouponSchema>;
export type NewcomerCouponOffer = z.infer<typeof NewcomerCouponOfferSchema>;
export type StoredValueCardStatus = z.infer<typeof StoredValueCardStatusSchema>;
export type StoredValueCardType = z.infer<typeof StoredValueCardTypeSchema>;
export type StoredValueCard = z.infer<typeof StoredValueCardSchema>;
export type CustomerWallet = z.infer<typeof CustomerWalletSchema>;
export type StoredValueRechargeCreate = z.infer<
  typeof StoredValueRechargeCreateSchema
>;
export type StoredValueRechargeIntent = z.infer<
  typeof StoredValueRechargeIntentSchema
>;
export type FirstRechargeRewardClaim = z.infer<
  typeof FirstRechargeRewardClaimSchema
>;
export type StoredValueTransaction = z.infer<
  typeof StoredValueTransactionSchema
>;
export type CustomerSettings = z.infer<typeof CustomerSettingsSchema>;
export type CustomerAddressCreate = z.infer<typeof CustomerAddressCreateSchema>;
export type CustomerAddressUpdate = z.infer<typeof CustomerAddressUpdateSchema>;
export type CustomerAddress = z.infer<typeof CustomerAddressSchema>;
export type CustomerFeedbackCreate = z.infer<
  typeof CustomerFeedbackCreateSchema
>;
export type CustomerFeedback = z.infer<typeof CustomerFeedbackSchema>;
export type AccountDeletionRequestCreate = z.infer<
  typeof AccountDeletionRequestCreateSchema
>;
export type AccountDeletionRequest = z.infer<
  typeof AccountDeletionRequestSchema
>;
export type AdminCustomerCenterSummary = z.infer<
  typeof AdminCustomerCenterSummarySchema
>;

export const formatMoney = (fen: number): string =>
  `¥${(fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)}`;

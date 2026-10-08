CREATE TYPE "CustomerCouponStatus" AS ENUM ('AVAILABLE', 'USED', 'EXPIRED');
CREATE TYPE "StoredValueCardStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');
CREATE TYPE "StoredValueCardType" AS ENUM ('PHYSICAL', 'DISCOUNT_93', 'DISCOUNT_90');
CREATE TYPE "CustomerFeedbackStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "AccountDeletionRequestStatus" AS ENUM ('PENDING', 'CANCELLED', 'COMPLETED');

CREATE TABLE "CustomerCenterConfig" (
  "organizationId" TEXT NOT NULL,
  "levelLabel" TEXT NOT NULL DEFAULT '普通用户',
  "customerServicePhone" TEXT,
  "cityNewsTitle" TEXT NOT NULL DEFAULT '城市快讯',
  "cityNewsContent" TEXT NOT NULL DEFAULT '中原到家持续为郑州用户提供规范上门服务',
  "appBannerTitle" TEXT NOT NULL DEFAULT '中原到家小程序',
  "appBannerSubtitle" TEXT NOT NULL DEFAULT '无需下载 APP，微信内即可预约',
  "appDownloadUrl" TEXT,
  "safeguardItems" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerCenterConfig_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "CustomerCoupon" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "amountFen" BIGINT NOT NULL,
  "minimumSpendFen" BIGINT NOT NULL,
  "applicability" TEXT NOT NULL DEFAULT '仅限服务项目费',
  "canApplyToTravelFee" BOOLEAN NOT NULL DEFAULT false,
  "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "CustomerCouponStatus" NOT NULL DEFAULT 'AVAILABLE',
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerCoupon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredValueAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "balanceFen" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoredValueAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredValueCard" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "StoredValueCardType" NOT NULL,
  "balanceFen" BIGINT NOT NULL DEFAULT 0,
  "status" "StoredValueCardStatus" NOT NULL DEFAULT 'AVAILABLE',
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoredValueCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredValueTransaction" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "changeFen" BIGINT NOT NULL,
  "balanceAfterFen" BIGINT NOT NULL,
  "description" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoredValueTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerFeedback" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "contentEncrypted" TEXT NOT NULL,
  "contactEncrypted" TEXT,
  "status" "CustomerFeedbackStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "CustomerFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountDeletionRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "reasonEncrypted" TEXT,
  "status" "AccountDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerAddress" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "contactNameEncrypted" TEXT NOT NULL,
  "phoneEncrypted" TEXT NOT NULL,
  "detailEncrypted" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "coordinateSystem" TEXT NOT NULL DEFAULT 'GCJ-02',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerAddress_coordinateSystem_check" CHECK ("coordinateSystem" = 'GCJ-02'),
  CONSTRAINT "CustomerAddress_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
  CONSTRAINT "CustomerAddress_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180)
);

CREATE INDEX "CustomerCoupon_organizationId_customerId_status_expiresAt_idx" ON "CustomerCoupon"("organizationId", "customerId", "status", "expiresAt");
CREATE UNIQUE INDEX "StoredValueAccount_organizationId_customerId_key" ON "StoredValueAccount"("organizationId", "customerId");
CREATE INDEX "StoredValueAccount_organizationId_updatedAt_idx" ON "StoredValueAccount"("organizationId", "updatedAt");
CREATE INDEX "StoredValueCard_accountId_status_type_idx" ON "StoredValueCard"("accountId", "status", "type");
CREATE INDEX "StoredValueTransaction_accountId_occurredAt_idx" ON "StoredValueTransaction"("accountId", "occurredAt");
CREATE INDEX "CustomerFeedback_organizationId_status_createdAt_idx" ON "CustomerFeedback"("organizationId", "status", "createdAt");
CREATE INDEX "CustomerFeedback_customerId_createdAt_idx" ON "CustomerFeedback"("customerId", "createdAt");
CREATE INDEX "AccountDeletionRequest_organizationId_status_createdAt_idx" ON "AccountDeletionRequest"("organizationId", "status", "createdAt");
CREATE INDEX "AccountDeletionRequest_customerId_status_createdAt_idx" ON "AccountDeletionRequest"("customerId", "status", "createdAt");
CREATE UNIQUE INDEX "AccountDeletionRequest_one_pending_per_customer_key" ON "AccountDeletionRequest"("customerId") WHERE "status" = 'PENDING';
CREATE INDEX "CustomerAddress_organizationId_customerId_isDefault_updatedAt_idx" ON "CustomerAddress"("organizationId", "customerId", "isDefault", "updatedAt");
CREATE UNIQUE INDEX "CustomerAddress_one_default_per_customer_org_key" ON "CustomerAddress"("organizationId", "customerId") WHERE "isDefault" = true;

ALTER TABLE "CustomerCenterConfig" ADD CONSTRAINT "CustomerCenterConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueAccount" ADD CONSTRAINT "StoredValueAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueAccount" ADD CONSTRAINT "StoredValueAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueCard" ADD CONSTRAINT "StoredValueCard_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoredValueAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoredValueTransaction" ADD CONSTRAINT "StoredValueTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoredValueAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFeedback" ADD CONSTRAINT "CustomerFeedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFeedback" ADD CONSTRAINT "CustomerFeedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_amountFen_check" CHECK ("amountFen" > 0);
ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_minimumSpendFen_check" CHECK ("minimumSpendFen" >= 0);
ALTER TABLE "StoredValueAccount" ADD CONSTRAINT "StoredValueAccount_balanceFen_check" CHECK ("balanceFen" >= 0);
ALTER TABLE "StoredValueCard" ADD CONSTRAINT "StoredValueCard_balanceFen_check" CHECK ("balanceFen" >= 0);
ALTER TABLE "StoredValueTransaction" ADD CONSTRAINT "StoredValueTransaction_balanceAfterFen_check" CHECK ("balanceAfterFen" >= 0);
ALTER TABLE "CustomerFeedback" ADD CONSTRAINT "CustomerFeedback_contentEncrypted_check" CHECK (length("contentEncrypted") > 0);
ALTER TABLE "CustomerCenterConfig" ADD CONSTRAINT "CustomerCenterConfig_appDownloadUrl_check" CHECK ("appDownloadUrl" IS NULL OR "appDownloadUrl" LIKE 'https://%');

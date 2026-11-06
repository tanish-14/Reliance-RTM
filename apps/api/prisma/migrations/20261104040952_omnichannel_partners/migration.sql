-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SYSTEM';

-- CreateTable
CREATE TABLE "PartnerIntegration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelCode" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'GENERIC_JSON',
    "config" JSONB NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "signingSecret" TEXT NOT NULL,
    "systemUserId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerOutlet" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalStoreId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,

    CONSTRAINT "PartnerOutlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerSku" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalSku" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PartnerSku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "orderNos" TEXT[],
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerIntegration_tenantId_code_key" ON "PartnerIntegration"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerOutlet_partnerId_externalStoreId_key" ON "PartnerOutlet"("partnerId", "externalStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerSku_partnerId_externalSku_key" ON "PartnerSku"("partnerId", "externalSku");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrder_partnerId_externalRef_key" ON "ExternalOrder"("partnerId", "externalRef");


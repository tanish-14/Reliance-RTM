-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaSecret" TEXT;

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "distributorId" TEXT,
    "title" TEXT NOT NULL,
    "amountPaise" BIGINT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requiredLevel" INTEGER NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "result" JSONB,
    "handledById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Approval_tenantId_status_idx" ON "Approval"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Consent_tenantId_subjectId_purpose_at_idx" ON "Consent"("tenantId", "subjectId", "purpose", "at");

-- CreateIndex
CREATE INDEX "DataRequest_tenantId_status_idx" ON "DataRequest"("tenantId", "status");


-- The consent trail is evidence (DPDP): append-only.
CREATE TRIGGER "Consent_append_only" BEFORE UPDATE OR DELETE ON "Consent" FOR EACH ROW EXECUTE FUNCTION rtm_forbid_mutation();

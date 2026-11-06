-- AlterTable
ALTER TABLE "CreditAccount" ADD COLUMN     "autoBlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bounceCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "overdueGraceDays" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "ackNo" TEXT,
ADD COLUMN     "irn" TEXT,
ADD COLUMN     "irnStatus" TEXT NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "ackDate" TIMESTAMP(3),
ADD COLUMN     "ackNo" TEXT,
ADD COLUMN     "ewbNo" TEXT,
ADD COLUMN     "ewbStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "ewbValidUntil" TIMESTAMP(3),
ADD COLUMN     "irnStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "signedQr" TEXT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "marginDiscPaise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "schemeDiscPaise" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cashbackPaise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMode" TEXT NOT NULL DEFAULT 'CREDIT';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "chequeBank" TEXT,
ADD COLUMN     "chequeDate" TIMESTAMP(3),
ADD COLUMN     "chequeNo" TEXT,
ADD COLUMN     "clearedAt" TIMESTAMP(3),
ADD COLUMN     "depositedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "gateway" TEXT,
ADD COLUMN     "gatewayPaymentId" TEXT,
ADD COLUMN     "intentId" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Scheme" ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentNo" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "orderId" TEXT,
    "purpose" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "gateway" TEXT NOT NULL,
    "gatewayOrderId" TEXT NOT NULL,
    "paymentLinkUrl" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailure" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayEvent" (
    "id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "refundNo" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "gatewayRefundId" TEXT,
    "reason" TEXT NOT NULL,
    "journalId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashDeposit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depositNo" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "expectedPaise" BIGINT NOT NULL,
    "declaredPaise" BIGINT NOT NULL,
    "variancePaise" BIGINT NOT NULL,
    "bankRef" TEXT NOT NULL,
    "slipDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "bankLineId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookOwner" TEXT NOT NULL,
    "valueDate" TIMESTAMP(3) NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchedType" TEXT,
    "matchedId" TEXT,
    "importBatch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceLineId" TEXT,
    "productId" TEXT,
    "kind" TEXT NOT NULL,
    "costPaise" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "claimNo" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "claimedPaise" BIGINT NOT NULL,
    "validatedPaise" BIGINT NOT NULL DEFAULT 0,
    "approvedPaise" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "flags" TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "journalId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "debitNoteNo" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "taxablePaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "journalId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_key_key" ON "Job"("key");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_gatewayOrderId_key" ON "PaymentIntent"("gatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_tenantId_intentNo_key" ON "PaymentIntent"("tenantId", "intentNo");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayEvent_eventId_key" ON "GatewayEvent"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_gatewayRefundId_key" ON "Refund"("gatewayRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_refundNo_key" ON "Refund"("tenantId", "refundNo");

-- CreateIndex
CREATE UNIQUE INDEX "CashDeposit_tenantId_depositNo_key" ON "CashDeposit"("tenantId", "depositNo");

-- CreateIndex
CREATE INDEX "BankStatementLine_tenantId_bookOwner_status_idx" ON "BankStatementLine"("tenantId", "bookOwner", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_tenantId_bookOwner_reference_amountPaise__key" ON "BankStatementLine"("tenantId", "bookOwner", "reference", "amountPaise", "valueDate");

-- CreateIndex
CREATE INDEX "SchemeUsage_tenantId_schemeId_distributorId_at_idx" ON "SchemeUsage"("tenantId", "schemeId", "distributorId", "at");

-- CreateIndex
CREATE INDEX "SchemeUsage_invoiceId_idx" ON "SchemeUsage"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_dedupeKey_key" ON "Claim"("dedupeKey");

-- CreateIndex
CREATE INDEX "Claim_tenantId_distributorId_schemeId_idx" ON "Claim"("tenantId", "distributorId", "schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_tenantId_claimNo_key" ON "Claim"("tenantId", "claimNo");

-- CreateIndex
CREATE UNIQUE INDEX "DebitNote_tenantId_debitNoteNo_key" ON "DebitNote"("tenantId", "debitNoteNo");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayPaymentId_key" ON "Payment"("gatewayPaymentId");


-- Scheme cost evidence is append-only, like the ledger.
CREATE TRIGGER "SchemeUsage_append_only" BEFORE UPDATE OR DELETE ON "SchemeUsage" FOR EACH ROW EXECUTE FUNCTION rtm_forbid_mutation();
CREATE TRIGGER "SchemeUsage_no_truncate" BEFORE TRUNCATE ON "SchemeUsage" FOR EACH STATEMENT EXECUTE FUNCTION rtm_forbid_mutation();
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_amounts_non_negative" CHECK ("claimedPaise" >= 0 AND "validatedPaise" >= 0 AND "approvedPaise" >= 0 AND "approvedPaise" <= "validatedPaise");
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_positive" CHECK ("amountPaise" > 0);

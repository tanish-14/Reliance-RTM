-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalRef" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationLog_target_at_idx" ON "IntegrationLog"("target", "at");


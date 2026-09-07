-- CreateTable
CREATE TABLE "ImportHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "avizNumber" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "transferName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ImportHistory_createdAt_idx" ON "ImportHistory"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportHistory_shop_avizNumber_key" ON "ImportHistory"("shop", "avizNumber");

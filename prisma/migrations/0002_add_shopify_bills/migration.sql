-- CreateEnum
CREATE TYPE "ShopifyBillStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "ShopifyBill" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "shopifyLocationId" TEXT,
    "shopifyLocationName" TEXT,
    "sourceName" TEXT,
    "total" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ShopifyBillStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "smartbillSeries" TEXT,
    "smartbillNumber" TEXT,
    "smartbillUrl" TEXT,
    "webhookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyBillItem" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "shopifyUnitPrice" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "taxRate" DOUBLE PRECISION,
    "taxName" TEXT,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "smartbillProductName" TEXT,
    "smartbillMeasuringUnit" TEXT,
    "smartbillStock" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyBill_shop_shopifyOrderId_key"
ON "ShopifyBill"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "ShopifyBill_shop_status_idx"
ON "ShopifyBill"("shop", "status");

-- CreateIndex
CREATE INDEX "ShopifyBill_createdAt_idx"
ON "ShopifyBill"("createdAt");

-- CreateIndex
CREATE INDEX "ShopifyBillItem_billId_idx"
ON "ShopifyBillItem"("billId");

-- CreateIndex
CREATE INDEX "ShopifyBillItem_sku_idx"
ON "ShopifyBillItem"("sku");

-- AddForeignKey
ALTER TABLE "ShopifyBillItem"
ADD CONSTRAINT "ShopifyBillItem_billId_fkey"
FOREIGN KEY ("billId") REFERENCES "ShopifyBill"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

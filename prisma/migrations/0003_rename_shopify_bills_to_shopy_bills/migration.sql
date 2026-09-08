-- Rename enum
ALTER TYPE "ShopifyBillStatus" RENAME TO "ShopyBillStatus";

-- Rename tables
ALTER TABLE "ShopifyBill" RENAME TO "ShopyBill";
ALTER TABLE "ShopifyBillItem" RENAME TO "ShopyBillItem";

-- Rename indexes
ALTER INDEX "ShopifyBill_shop_shopifyOrderId_key"
RENAME TO "ShopyBill_shop_shopifyOrderId_key";

ALTER INDEX "ShopifyBill_shop_status_idx"
RENAME TO "ShopyBill_shop_status_idx";

ALTER INDEX "ShopifyBill_createdAt_idx"
RENAME TO "ShopyBill_createdAt_idx";

ALTER INDEX "ShopifyBillItem_billId_idx"
RENAME TO "ShopyBillItem_billId_idx";

ALTER INDEX "ShopifyBillItem_sku_idx"
RENAME TO "ShopyBillItem_sku_idx";

-- Rename primary-key constraints
ALTER TABLE "ShopyBill"
RENAME CONSTRAINT "ShopifyBill_pkey" TO "ShopyBill_pkey";

ALTER TABLE "ShopyBillItem"
RENAME CONSTRAINT "ShopifyBillItem_pkey" TO "ShopyBillItem_pkey";

-- Rename foreign-key constraint
ALTER TABLE "ShopyBillItem"
RENAME CONSTRAINT "ShopifyBillItem_billId_fkey"
TO "ShopyBillItem_billId_fkey";
import { useEffect, useState } from "react";

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";

import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// ============================================================
// SHOPIFY LOCATIONS
// ============================================================

const LOCATION_PROMENADA = {
  id: "gid://shopify/Location/88240128340",
  name: "Magazin Promenada",
  deliveryAddressKeyword: "Calea Floreasca",
};

const LOCATION_SEDIU = {
  id: "gid://shopify/Location/52695138464",
  name: "Sediu Principal",
  deliveryAddressKeyword: "Calea Rahovei",
};

// ============================================================
// SHOPIFY ADMIN URL
// ============================================================

function getTransferAdminUrl(
  shop: string,
  transferId: string,
) {
  const numericId = transferId.split("/").pop();
  const storeHandle = shop.replace(".myshopify.com", "");

  return numericId
    ? `https://admin.shopify.com/store/${storeHandle}/transfers/${numericId}`
    : `https://admin.shopify.com/store/${storeHandle}/transfers`;
}

// ============================================================
// TYPES
// ============================================================

type AvizItem = {
  sku: string;
  quantity: number;
};

type ParsedAviz = {
  number: string;
  date: string;
  deliveryAddress: string;
  items: AvizItem[];
};

type TransferItem = {
  sku: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  inventoryItemId: string;
};

type TransferLocation = {
  id: string;
  name: string;
};

type ActionResult =
  | {
      ok: true;
      mode: "preview";
      aviz: ParsedAviz;
      direction: {
        origin: string;
        destination: string;
      };
      items: TransferItem[];
    }
  | {
      ok: true;
      mode: "transfer";
      transfer: {
        id: string;
        name: string;
        status: string;
        referenceName: string | null;
        origin: string;
        destination: string;
        adminUrl: string;
      };
      items: Array<{
        sku: string;
        quantity: number;
        inventoryItemId: string;
      }>;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
    };

// ============================================================
// LOADER
// ============================================================

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {};
};

// ============================================================
// ADDRESS HELPERS
// ============================================================

function normalizeDeliveryAddress(value: string) {
  return value
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ============================================================
// IDENTIFY DESTINATION
// ============================================================
//
// CASE-SENSITIVE
//
// Calea Floreasca -> Magazin Promenada
// Calea Rahovei   -> Sediu Principal
//
// ============================================================

function getDestinationLocation(
  deliveryAddress: string,
): TransferLocation | null {
  const normalizedAddress =
    normalizeDeliveryAddress(deliveryAddress);

  console.log(
    "[LOCATION DEBUG] Normalized delivery address:",
    normalizedAddress,
  );

  console.log(
    "[LOCATION DEBUG] Checking Promenada keyword:",
    LOCATION_PROMENADA.deliveryAddressKeyword,
  );

  if (
    normalizedAddress.includes(
      LOCATION_PROMENADA.deliveryAddressKeyword,
    )
  ) {
    console.log(
      "[LOCATION DEBUG] MATCH -> Magazin Promenada",
    );

    return {
      id: LOCATION_PROMENADA.id,
      name: LOCATION_PROMENADA.name,
    };
  }

  console.log(
    "[LOCATION DEBUG] Checking Sediu keyword:",
    LOCATION_SEDIU.deliveryAddressKeyword,
  );

  if (
    normalizedAddress.includes(
      LOCATION_SEDIU.deliveryAddressKeyword,
    )
  ) {
    console.log(
      "[LOCATION DEBUG] MATCH -> Sediu Principal",
    );

    return {
      id: LOCATION_SEDIU.id,
      name: LOCATION_SEDIU.name,
    };
  }

  console.log(
    "[LOCATION DEBUG] NO LOCATION MATCH",
  );

  return null;
}

// ============================================================
// GET OTHER LOCATION
// ============================================================

function getOriginLocation(
  destinationLocation: TransferLocation,
): TransferLocation {
  if (
    destinationLocation.id ===
    LOCATION_PROMENADA.id
  ) {
    return {
      id: LOCATION_SEDIU.id,
      name: LOCATION_SEDIU.name,
    };
  }

  return {
    id: LOCATION_PROMENADA.id,
    name: LOCATION_PROMENADA.name,
  };
}

// ============================================================
// PDF PARSER
// ============================================================

function parseAviz(
  text: string,
): ParsedAviz {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // ----------------------------------------------------------
  // NUMBER
  // ----------------------------------------------------------

  const numberMatch = normalized.match(
    /\b(AVIZ[A-Z0-9-]+)\b/i,
  );

  if (!numberMatch) {
    throw new Error(
      "Could not identify the delivery note number.",
    );
  }

  // ----------------------------------------------------------
  // DATE
  // ----------------------------------------------------------

  const dateMatch = normalized.match(
    /Data\s+emiterii\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i,
  );

  if (!dateMatch) {
    throw new Error(
      "Could not identify the delivery note date.",
    );
  }

  const date =
    `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

  // ----------------------------------------------------------
  // DELIVERY ADDRESS
  // ----------------------------------------------------------

  const deliveryAddressMatch =
    normalized.match(
      /Adresa\s+de\s+livrare:\s*([\s\S]*?)(?=\nIBAN|\nBanca:|\nAdresa:|\nCIF:|\nReg\.\s*com\.|\nNr\.\s*crt|$)/i,
    );

  if (!deliveryAddressMatch) {
    throw new Error(
      "Could not identify the delivery address.",
    );
  }

  const deliveryAddress =
    deliveryAddressMatch[1]
      .replace(/\s+/g, " ")
      .trim();

  if (!deliveryAddress) {
    throw new Error(
      "The delivery address is empty.",
    );
  }

  console.log(
    "[SMARTBILL] Delivery address used for location identification:",
    deliveryAddress,
  );

  // ----------------------------------------------------------
  // SKU + QUANTITY
  // ----------------------------------------------------------

  const skuMatches = [
    ...normalized.matchAll(
      /\(([A-Z0-9][A-Z0-9-]{5,})\)/gi,
    ),
  ];

  const items: AvizItem[] = [];

  for (
    let i = 0;
    i < skuMatches.length;
    i++
  ) {
    const sku =
      skuMatches[i][1].toUpperCase();

    const start =
      skuMatches[i].index ?? 0;

    const end =
      i + 1 < skuMatches.length
        ? skuMatches[i + 1].index ??
          normalized.length
        : normalized.length;

    const block =
      normalized.slice(
        start,
        end,
      );

    const quantityMatch =
      block.match(
        /\bbuc\s+(\d+(?:[.,]\d+)?)\b/i,
      );

    if (!quantityMatch) {
      throw new Error(
        `Could not identify the quantity for SKU ${sku}.`,
      );
    }

    const quantity = Number(
      quantityMatch[1].replace(",", "."),
    );

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        `Invalid quantity for SKU ${sku}.`,
      );
    }

    items.push({
      sku,
      quantity,
    });
  }

  if (items.length === 0) {
    throw new Error(
      "No SKUs were identified in the PDF.",
    );
  }

  return {
    number:
      numberMatch[1].toUpperCase(),
    date,
    deliveryAddress,
    items,
  };
}

// ============================================================
// PDF TEXT EXTRACTION
// ============================================================

async function extractPdfText(
  file: File,
) {
  const started =
    performance.now();

  const arrayBuffer =
    await file.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  console.log(
    `[SMARTBILL] PDF received: ${file.name} (${buffer.length} bytes)`,
  );

  const { PDFParse } =
    await import("pdf-parse");

  const parser = new PDFParse({
    data: buffer,
  });

  try {
    const result =
      await parser.getText();

    console.log(
      `[SMARTBILL] PDF parse: ${(performance.now() - started).toFixed(0)} ms`,
    );

    console.log(
      `[SMARTBILL] Extracted text: ${result.text.length} characters`,
    );

    return result.text;
  } finally {
    await parser.destroy();
  }
}

// ============================================================
// SKU LOOKUP
// ============================================================

async function findSkuInShopify(
  admin: any,
  sku: string,
): Promise<TransferItem> {
  console.log(
    `[SHOPIFY SKU] Looking up SKU: ${sku}`,
  );

  const response =
    await admin.graphql(
      `#graphql
        query FindVariantBySku($query: String!) {
          productVariants(
            first: 10
            query: $query
          ) {
            nodes {
              sku
              title
              product {
                title
              }
              inventoryItem {
                id
              }
            }
          }
        }
      `,
      {
        variables: {
          query: `sku:${sku}`,
        },
      },
    );

  const json =
    (await response.json()) as any;

  console.log(
    `[SHOPIFY SKU] Response for ${sku}:`,
    JSON.stringify(
      json,
      null,
      2,
    ),
  );

  if (json.errors) {
    throw new Error(
      `Shopify SKU lookup failed for ${sku}.`,
    );
  }

  const nodes =
    json.data?.productVariants?.nodes ??
    [];

  const variant =
    nodes.find(
      (node: any) =>
        node.sku?.toUpperCase() ===
        sku.toUpperCase(),
    );

  if (!variant) {
    throw new Error(
      `SKU ${sku} was not found in Shopify.`,
    );
  }

  if (
    !variant.inventoryItem?.id
  ) {
    throw new Error(
      `SKU ${sku} does not have an Inventory Item in Shopify.`,
    );
  }

  console.log(
    `[SHOPIFY SKU] FOUND ${sku}`,
    {
      productTitle:
        variant.product?.title,
      variantTitle:
        variant.title,
      inventoryItemId:
        variant.inventoryItem.id,
    },
  );

  return {
    sku,
    quantity: 0,
    productTitle:
      variant.product?.title ?? "",
    variantTitle:
      variant.title ?? "",
    inventoryItemId:
      variant.inventoryItem.id,
  };
}

// ============================================================
// VERIFY SHOPIFY LOCATIONS
// ============================================================
//
// IMPORTANT:
// We do NOT replace the IDs.
// We only verify what Shopify returns for them.
//
// ============================================================

async function verifyShopifyLocations(
  admin: any,
) {
  console.log(
    "============================================================",
  );

  console.log(
    "[LOCATION VERIFY] START",
  );

  console.log(
    "[LOCATION VERIFY] Promenada ID:",
    LOCATION_PROMENADA.id,
  );

  console.log(
    "[LOCATION VERIFY] Sediu ID:",
    LOCATION_SEDIU.id,
  );

  const response =
    await admin.graphql(
      `#graphql
        query VerifyLocations(
          $promenadaId: ID!
          $sediuId: ID!
        ) {
          promenada: location(id: $promenadaId) {
            id
            name
            isActive
          }

          sediu: location(id: $sediuId) {
            id
            name
            isActive
          }
        }
      `,
      {
        variables: {
          promenadaId:
            LOCATION_PROMENADA.id,

          sediuId:
            LOCATION_SEDIU.id,
        },
      },
    );

  const json =
    (await response.json()) as any;

  console.log(
    "[LOCATION VERIFY] Shopify response:",
    JSON.stringify(
      json,
      null,
      2,
    ),
  );

  if (json.errors) {
    console.error(
      "[LOCATION VERIFY] GraphQL errors:",
      JSON.stringify(
        json.errors,
        null,
        2,
      ),
    );
  }

  console.log(
    "[LOCATION VERIFY] END",
  );

  console.log(
    "============================================================",
  );

  return json;
}

// ============================================================
// ACTION
// ============================================================

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin, session } =
    await authenticate.admin(request);

  try {
    console.log(
      "============================================================",
    );

    console.log(
      "[SMARTBILL] REQUEST START",
      new Date().toISOString(),
    );

    console.log(
      "[SMARTBILL] SHOP:",
      session.shop,
    );

    const formData =
      await request.formData();

    const createTransfer =
      formData.get(
        "createTransfer",
      ) === "true";

    // ========================================================
    // CREATE TRANSFER
    // ========================================================

    if (createTransfer) {
      console.log(
        "============================================================",
      );

      console.log(
        "[SMARTBILL] CREATE TRANSFER START",
        new Date().toISOString(),
      );

      const transferDataRaw =
        formData.get(
          "transferData",
        );

      if (
        typeof transferDataRaw !==
        "string"
      ) {
        return {
          ok: false,
          error:
            "Preview data is missing. Please process the PDF again.",
        };
      }

      let transferData: {
        aviz: ParsedAviz;
        items: TransferItem[];
        originLocation: TransferLocation;
        destinationLocation: TransferLocation;
      };

      try {
        transferData =
          JSON.parse(
            transferDataRaw,
          );
      } catch {
        return {
          ok: false,
          error:
            "The transfer data is invalid.",
        };
      }

      const {
        aviz,
        items,
        originLocation,
        destinationLocation,
      } = transferData;

      if (
        !aviz?.number ||
        !originLocation?.id ||
        !destinationLocation?.id ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return {
          ok: false,
          error:
            "Incomplete data for creating the transfer.",
        };
      }

      // ------------------------------------------------------
      // DEBUG - TRANSFER INPUT
      // ------------------------------------------------------

      console.log(
        "============================================================",
      );

      console.log(
        "[TRANSFER DEBUG] AVIZ:",
        aviz.number,
      );

      console.log(
        "[TRANSFER DEBUG] DATE:",
        aviz.date,
      );

      console.log(
        "[TRANSFER DEBUG] DELIVERY ADDRESS:",
        aviz.deliveryAddress,
      );

      console.log(
        "[TRANSFER DEBUG] ORIGIN:",
        JSON.stringify(
          originLocation,
          null,
          2,
        ),
      );

      console.log(
        "[TRANSFER DEBUG] DESTINATION:",
        JSON.stringify(
          destinationLocation,
          null,
          2,
        ),
      );

      console.log(
        "[TRANSFER DEBUG] ITEMS:",
        JSON.stringify(
          items,
          null,
          2,
        ),
      );

      // ------------------------------------------------------
      // DUPLICATE CHECK
      // ------------------------------------------------------

      const existingImport =
        await prisma.importHistory.findUnique({
          where: {
            shop_avizNumber: {
              shop: session.shop,
              avizNumber:
                aviz.number,
            },
          },
        });

      if (existingImport) {
        console.log(
          "[TRANSFER DEBUG] DUPLICATE FOUND:",
          existingImport,
        );

        return {
          ok: false,
          error:
            `Delivery note ${aviz.number} has already been imported as ${existingImport.transferName}.`,
        };
      }

      // ------------------------------------------------------
      // VERIFY LOCATIONS
      // ------------------------------------------------------

      const locationVerification =
        await verifyShopifyLocations(
          admin,
        );

      console.log(
        "[TRANSFER DEBUG] Location verification result:",
        JSON.stringify(
          locationVerification,
          null,
          2,
        ),
      );

      // ------------------------------------------------------
      // BUILD LINE ITEMS
      // ------------------------------------------------------

      const lineItems =
        items.map(
          (item) => ({
            inventoryItemId:
              item.inventoryItemId,

            quantity:
              item.quantity,
          }),
        );

      console.log(
        "[TRANSFER DEBUG] LINE ITEMS SENT TO SHOPIFY:",
        JSON.stringify(
          lineItems,
          null,
          2,
        ),
      );

      // ------------------------------------------------------
      // IDEMPOTENCY
      // ------------------------------------------------------
      //
      // NEW KEY FOR EVERY MANUAL CREATE ATTEMPT.
      //
      // Shopify requires an idempotency key for this mutation
      // on API versions where the feature is required.
      //
      // A previous failed request must not be retried using
      // the same old key.
      //
      // ------------------------------------------------------

      const idempotencyKey =
        `smartbill-${session.shop}-${aviz.number}-${crypto.randomUUID()}`;

      console.log(
        "[TRANSFER DEBUG] IDEMPOTENCY KEY:",
        idempotencyKey,
      );

      // ------------------------------------------------------
      // SHOPIFY INPUT
      // ------------------------------------------------------

      const shopifyInput = {
        originLocationId:
          originLocation.id,

        destinationLocationId:
          destinationLocation.id,

        referenceName:
          aviz.number,

        dateCreated:
          aviz.date
            ? `${aviz.date}T00:00:00Z`
            : undefined,

        note:
          `SmartBill delivery note ${aviz.number}`,

        lineItems,
      };

      console.log(
        "============================================================",
      );

      console.log(
        "[SHOPIFY CREATE] INPUT:",
        JSON.stringify(
          shopifyInput,
          null,
          2,
        ),
      );

      console.log(
        "[SHOPIFY CREATE] ORIGIN LOCATION ID:",
        originLocation.id,
      );

      console.log(
        "[SHOPIFY CREATE] ORIGIN LOCATION NAME:",
        originLocation.name,
      );

      console.log(
        "[SHOPIFY CREATE] DESTINATION LOCATION ID:",
        destinationLocation.id,
      );

      console.log(
        "[SHOPIFY CREATE] DESTINATION LOCATION NAME:",
        destinationLocation.name,
      );

      console.log(
        "[SHOPIFY CREATE] IDEMPOTENCY:",
        idempotencyKey,
      );

      console.log(
        "[SHOPIFY CREATE] START:",
        new Date().toISOString(),
      );

      // ------------------------------------------------------
      // MUTATION
      // ------------------------------------------------------
      //
      // IMPORTANT:
      //
      // origin/destination are LocationSnapshot.
      //
      // LocationSnapshot DOES NOT have "id".
      //
      // Therefore we request ONLY "name" here.
      //
      // The actual Location IDs are already correctly sent
      // through originLocationId and destinationLocationId
      // in shopifyInput above.
      //
      // ------------------------------------------------------

      const mutation = `#graphql
        mutation CreateInventoryTransfer(
          $input: InventoryTransferCreateInput!
          $idempotencyKey: String!
        ) {
          inventoryTransferCreate(
            input: $input
          ) @idempotent(
            key: $idempotencyKey
          ) {
            inventoryTransfer {
              id
              name
              status
              referenceName

              origin {
                name
              }

              destination {
                name
              }
            }

            userErrors {
              field
              message
              code
            }
          }
        }
      `;

      const started =
        performance.now();

      console.log(
        "[SHOPIFY CREATE] Sending mutation...",
      );

      const response =
        await admin.graphql(
          mutation,
          {
            variables: {
              input:
                shopifyInput,

              idempotencyKey,
            },
          },
        );

      const json =
        (await response.json()) as any;

      const duration =
        performance.now() -
        started;

      // ------------------------------------------------------
      // FULL SHOPIFY RESPONSE
      // ------------------------------------------------------

      console.log(
        "============================================================",
      );

      console.log(
        `[SHOPIFY CREATE] RESPONSE TIME: ${duration.toFixed(0)} ms`,
      );

      console.log(
        "[SHOPIFY CREATE] FULL JSON RESPONSE:",
        JSON.stringify(
          json,
          null,
          2,
        ),
      );

      // ------------------------------------------------------
      // GRAPHQL ERRORS
      // ------------------------------------------------------

      if (json.errors) {
        console.error(
          "============================================================",
        );

        console.error(
          "[SHOPIFY CREATE] GRAPHQL ERRORS:",
          JSON.stringify(
            json.errors,
            null,
            2,
          ),
        );

        console.error(
          "[SHOPIFY CREATE] INPUT:",
          JSON.stringify(
            shopifyInput,
            null,
            2,
          ),
        );

        console.error(
          "[SHOPIFY CREATE] IDEMPOTENCY:",
          idempotencyKey,
        );

        return {
          ok: false,
          error:
            "Shopify returned a GraphQL error while creating the transfer.",
          details:
            json.errors,
        };
      }

      const result =
        json.data
          ?.inventoryTransferCreate;

      if (!result) {
        console.error(
          "[SHOPIFY CREATE] NO MUTATION RESULT:",
          JSON.stringify(
            json,
            null,
            2,
          ),
        );

        return {
          ok: false,
          error:
            "Shopify did not return a transfer creation result.",
          details: json,
        };
      }

      // ------------------------------------------------------
      // USER ERRORS
      // ------------------------------------------------------

      if (
        result.userErrors?.length
      ) {
        console.error(
          "============================================================",
        );

        console.error(
          "[SHOPIFY CREATE] USER ERRORS:",
        );

        console.error(
          JSON.stringify(
            result.userErrors,
            null,
            2,
          ),
        );

        console.error(
          "[SHOPIFY CREATE] INPUT THAT CAUSED ERROR:",
        );

        console.error(
          JSON.stringify(
            shopifyInput,
            null,
            2,
          ),
        );

        console.error(
          "[SHOPIFY CREATE] IDEMPOTENCY KEY:",
          idempotencyKey,
        );

        console.error(
          "============================================================",
        );

        const firstError =
          result.userErrors[0];

        let readableError =
          "Shopify rejected the transfer creation.";

        if (
          firstError.code ===
          "TRANSFER_NOT_FOUND"
        ) {
          readableError =
            "Shopify says the inventory transfer cannot be found.";
        }

        if (
          firstError.code ===
          "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED"
        ) {
          readableError =
            "Shopify says the previous attempt with this idempotency key failed. A new idempotency key was used for this attempt.";
        }

        if (
          firstError.code ===
          "LOCATION_NOT_FOUND"
        ) {
          readableError =
            "Shopify says one of the selected locations cannot be found.";
        }

        if (
          firstError.code ===
          "LOCATION_NOT_ACTIVE"
        ) {
          readableError =
            "Shopify says one of the selected locations is inactive.";
        }

        if (
          firstError.code ===
          "INVENTORY_STATE_NOT_ACTIVE"
        ) {
          readableError =
            "Shopify says one or more inventory items are not stocked at the selected location.";
        }

        if (
          firstError.code ===
          "ITEM_NOT_FOUND"
        ) {
          readableError =
            "Shopify says one of the inventory items cannot be found.";
        }

        if (
          firstError.code ===
          "TRANSFER_ORIGIN_CANNOT_BE_THE_SAME_AS_DESTINATION"
        ) {
          readableError =
            "Shopify says the origin and destination locations cannot be the same.";
        }

        return {
          ok: false,
          error: readableError,
          details: {
            userErrors:
              result.userErrors,

            originLocationId:
              originLocation.id,

            destinationLocationId:
              destinationLocation.id,

            lineItems,

            idempotencyKey,
          },
        };
      }

      // ------------------------------------------------------
      // NO TRANSFER RETURNED
      // ------------------------------------------------------

      if (
        !result.inventoryTransfer
      ) {
        console.error(
          "[SHOPIFY CREATE] NO TRANSFER RETURNED:",
          JSON.stringify(
            result,
            null,
            2,
          ),
        );

        return {
          ok: false,
          error:
            "Shopify did not return the created transfer.",
          details: result,
        };
      }

      // ------------------------------------------------------
      // SUCCESS
      // ------------------------------------------------------

      const transfer =
        result.inventoryTransfer;

      const adminUrl =
        getTransferAdminUrl(
          session.shop,
          transfer.id,
        );

      console.log(
        "============================================================",
      );

      console.log(
        "[SHOPIFY CREATE] SUCCESS",
      );

      console.log(
        "[SHOPIFY CREATE] TRANSFER ID:",
        transfer.id,
      );

      console.log(
        "[SHOPIFY CREATE] TRANSFER NAME:",
        transfer.name,
      );

      console.log(
        "[SHOPIFY CREATE] STATUS:",
        transfer.status,
      );

      console.log(
        "[SHOPIFY CREATE] REFERENCE:",
        transfer.referenceName,
      );

      console.log(
        "[SHOPIFY CREATE] ORIGIN:",
        JSON.stringify(
          transfer.origin,
          null,
          2,
        ),
      );

      console.log(
        "[SHOPIFY CREATE] DESTINATION:",
        JSON.stringify(
          transfer.destination,
          null,
          2,
        ),
      );

      // ------------------------------------------------------
      // SAVE IMPORT HISTORY
      // ------------------------------------------------------

      await prisma.importHistory.create({
        data: {
          shop: session.shop,

          avizNumber:
            aviz.number,

          transferId:
            transfer.id,

          transferName:
            transfer.name,
        },
      });

      console.log(
        "[SMARTBILL] Import history saved:",
        aviz.number,
      );

      console.log(
        "[SMARTBILL] BEFORE RESPONSE",
        new Date().toISOString(),
      );

      return {
        ok: true,
        mode: "transfer",

        transfer: {
          id:
            transfer.id,

          name:
            transfer.name,

          status:
            transfer.status,

          referenceName:
            transfer.referenceName,

          origin:
            transfer.origin.name,

          destination:
            transfer.destination.name,

          adminUrl,
        },

        items: items.map(
          (item) => ({
            sku: item.sku,
            quantity:
              item.quantity,
            inventoryItemId:
              item.inventoryItemId,
          }),
        ),
      };
    }

    // ========================================================
    // PREVIEW
    // ========================================================

    const file =
      formData.get("pdf");

    if (!(file instanceof File)) {
      return {
        ok: false,
        error:
          "No PDF file was selected.",
      };
    }

    if (file.size === 0) {
      return {
        ok: false,
        error:
          "The PDF file is empty.",
      };
    }

    const isPdf =
      file.type ===
        "application/pdf" ||
      file.name
        .toLowerCase()
        .endsWith(".pdf");

    if (!isPdf) {
      return {
        ok: false,
        error:
          "The selected file must be a PDF.",
      };
    }

    console.log(
      "============================================================",
    );

    console.log(
      "=== SMARTBILL PDF IMPORT START ===",
    );

    // --------------------------------------------------------
    // 1. EXTRACT PDF
    // --------------------------------------------------------

    const avizText =
      await extractPdfText(file);

    if (!avizText.trim()) {
      return {
        ok: false,
        error:
          "The PDF does not contain extractable text.",
      };
    }

    // --------------------------------------------------------
    // 2. PARSE
    // --------------------------------------------------------

    let aviz: ParsedAviz;

    try {
      aviz =
        parseAviz(
          avizText,
        );
    } catch (error) {
      console.error(
        "[SMARTBILL] PARSE ERROR:",
        error,
      );

      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not parse the delivery note.",
      };
    }

    console.log(
      "[SMARTBILL] Delivery note identified:",
      aviz.number,
    );

    console.log(
      "[SMARTBILL] Delivery date:",
      aviz.date,
    );

    console.log(
      "[SMARTBILL] Delivery address:",
      aviz.deliveryAddress,
    );

    console.log(
      "[SMARTBILL] SKUs:",
      JSON.stringify(
        aviz.items,
        null,
        2,
      ),
    );

    // --------------------------------------------------------
    // 3. DUPLICATE CHECK
    // --------------------------------------------------------

    const existingImport =
      await prisma.importHistory.findUnique({
        where: {
          shop_avizNumber: {
            shop: session.shop,
            avizNumber:
              aviz.number,
          },
        },
      });

    if (existingImport) {
      return {
        ok: false,
        error:
          `Delivery note ${aviz.number} has already been imported as ${existingImport.transferName}.`,
      };
    }

    // --------------------------------------------------------
    // 4. DESTINATION
    // --------------------------------------------------------

    const destinationLocation =
      getDestinationLocation(
        aviz.deliveryAddress,
      );

    if (!destinationLocation) {
      return {
        ok: false,
        error:
          "The delivery address does not contain a valid location keyword. Expected case-sensitive 'Calea Floreasca' for Magazin Promenada or 'Calea Rahovei' for Sediu Principal.",

        details: {
          deliveryAddress:
            aviz.deliveryAddress,

          expectedKeywords: {
            promenada:
              LOCATION_PROMENADA
                .deliveryAddressKeyword,

            sediu:
              LOCATION_SEDIU
                .deliveryAddressKeyword,
          },
        },
      };
    }

    // --------------------------------------------------------
    // 5. ORIGIN
    // --------------------------------------------------------

    const originLocation =
      getOriginLocation(
        destinationLocation,
      );

    console.log(
      "============================================================",
    );

    console.log(
      "=== TRANSFER DIRECTION ===",
    );

    console.log(
      "[DIRECTION] Delivery address:",
      aviz.deliveryAddress,
    );

    console.log(
      "[DIRECTION] Origin:",
      JSON.stringify(
        originLocation,
        null,
        2,
      ),
    );

    console.log(
      "[DIRECTION] Destination:",
      JSON.stringify(
        destinationLocation,
        null,
        2,
      ),
    );

    // --------------------------------------------------------
    // 6. SKU LOOKUP
    // --------------------------------------------------------

    const skuStarted =
      performance.now();

    try {
      const foundItems =
        await Promise.all(
          aviz.items.map(
            async (item) => {
              const found =
                await findSkuInShopify(
                  admin,
                  item.sku,
                );

              return {
                ...found,
                quantity:
                  item.quantity,
              };
            },
          ),
        );

      console.log(
        `[SMARTBILL] Shopify SKU lookup: ${(performance.now() - skuStarted).toFixed(0)} ms`,
      );

      console.log(
        "[SMARTBILL] All SKUs were found in Shopify.",
      );

      console.log(
        "[SMARTBILL] BEFORE RESPONSE",
        new Date().toISOString(),
      );

      return {
        ok: true,
        mode: "preview",

        aviz,

        direction: {
          origin:
            originLocation.name,

          destination:
            destinationLocation.name,
        },

        items: foundItems,
      };
    } catch (error) {
      console.error(
        "[SMARTBILL] SKU LOOKUP ERROR:",
        error,
      );

      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while looking up products in Shopify.",
      };
    }
  } catch (error) {
    console.error(
      "============================================================",
    );

    console.error(
      "SMARTBILL IMPORT ERROR:",
      error,
    );

    console.error(
      "============================================================",
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while processing the PDF.",
    };
  }
};

// ============================================================
// UI
// ============================================================

export default function Index() {
  const fetcher =
    useFetcher<ActionResult>();

  const shopify =
    useAppBridge();

  const [file, setFile] =
    useState<File | null>(null);

  const isLoading =
    ["loading", "submitting"].includes(
      fetcher.state,
    ) &&
    fetcher.formMethod === "POST";

  const previewData =
    fetcher.data?.ok &&
    fetcher.data.mode ===
      "preview"
      ? fetcher.data
      : null;

  const transferData =
    fetcher.data?.ok &&
    fetcher.data.mode ===
      "transfer"
      ? fetcher.data
      : null;

  useEffect(() => {
    if (transferData) {
      shopify.toast.show(
        `Transfer created for ${
          transferData.transfer
            .referenceName ??
          "delivery note"
        }.`,
      );
    }

    if (
      fetcher.data &&
      !fetcher.data.ok
    ) {
      shopify.toast.show(
        fetcher.data.error,
      );
    }
  }, [
    fetcher.data,
    shopify,
    transferData,
  ]);

  // ==========================================================
  // UPLOAD PDF
  // ==========================================================

  const uploadPdf = (
    selectedFile: File,
  ) => {
    const formData =
      new FormData();

    formData.append(
      "pdf",
      selectedFile,
    );

    formData.append(
      "createTransfer",
      "false",
    );

    fetcher.submit(
      formData,
      {
        method: "POST",
        encType:
          "multipart/form-data",
      },
    );
  };

  // ==========================================================
  // CREATE TRANSFER
  // ==========================================================

  const createTransfer = () => {
    if (!previewData) {
      return;
    }

    const destinationLocation =
      getDestinationLocation(
        previewData.aviz
          .deliveryAddress,
      );

    if (!destinationLocation) {
      shopify.toast.show(
        "The delivery address could not be matched to a Shopify location.",
      );

      return;
    }

    const originLocation =
      getOriginLocation(
        destinationLocation,
      );

    console.log(
      "[CLIENT DEBUG] CREATE TRANSFER",
      {
        aviz:
          previewData.aviz.number,

        deliveryAddress:
          previewData.aviz
            .deliveryAddress,

        origin:
          originLocation,

        destination:
          destinationLocation,

        items:
          previewData.items,
      },
    );

    const formData =
      new FormData();

    formData.append(
      "createTransfer",
      "true",
    );

    formData.append(
      "transferData",
      JSON.stringify({
        aviz:
          previewData.aviz,

        items:
          previewData.items,

        originLocation,

        destinationLocation,
      }),
    );

    fetcher.submit(
      formData,
      {
        method: "POST",
      },
    );
  };

  // ==========================================================
  // RENDER
  // ==========================================================

  return (
    <s-page heading="ShopyBill">

      <s-section heading="Import SmartBill Delivery Note">

        <s-stack
          direction="block"
          gap="base"
        >

          <s-paragraph>
            Upload a SmartBill delivery
            note in PDF format.
          </s-paragraph>

          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const selectedFile =
                event.target.files?.[0] ??
                null;

              setFile(
                selectedFile,
              );

              if (selectedFile) {
                uploadPdf(
                  selectedFile,
                );
              }
            }}
          />

          {file ? (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >

                <span>
                  <strong>
                    Selected file:
                  </strong>
                </span>

                <span>
                  {file.name}
                </span>

                <span>
                  {(
                    file.size /
                    1024
                  ).toFixed(1)}{" "}
                  KB
                </span>

                {isLoading ? (
                  <span>
                    Processing PDF...
                  </span>
                ) : null}

              </s-stack>
            </s-box>
          ) : null}

        </s-stack>

      </s-section>

      {previewData ? (
        <s-section
          heading={`Delivery Note ${previewData.aviz.number}`}
        >

          <s-stack
            direction="block"
            gap="base"
          >

            <s-paragraph>
              <strong>
                Date:
              </strong>{" "}
              {previewData.aviz.date ||
                "Not specified"}
            </s-paragraph>

            <s-paragraph>
              <strong>
                Delivery address:
              </strong>{" "}
              {
                previewData.aviz
                  .deliveryAddress
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Direction:
              </strong>{" "}
              {
                previewData.direction
                  .origin
              }
              {" → "}
              {
                previewData.direction
                  .destination
              }
            </s-paragraph>

            <s-divider />

            <s-heading>
              Products
            </s-heading>

            {previewData.items.map(
              (item) => (
                <s-box
                  key={item.sku}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >

                  <s-stack
                    direction="block"
                    gap="small"
                  >

                    <span>
                      <strong>
                        {item.sku}
                      </strong>
                    </span>

                    <span>
                      <strong>
                        Product:
                      </strong>{" "}
                      {
                        item.productTitle
                      }
                    </span>

                    <span>
                      <strong>
                        Variant:
                      </strong>{" "}
                      {
                        item.variantTitle
                      }
                    </span>

                    <span>
                      <strong>
                        Quantity:
                      </strong>{" "}
                      {
                        item.quantity
                      }
                    </span>

                  </s-stack>

                </s-box>
              ),
            )}

            <s-button
              variant="primary"
              onClick={
                createTransfer
              }
              {...(
                isLoading
                  ? {
                      loading: true,
                    }
                  : {}
              )}
            >
              {isLoading
                ? "Creating transfer..."
                : "Create transfer"}
            </s-button>

          </s-stack>

        </s-section>
      ) : null}

      {fetcher.data &&
      !fetcher.data.ok ? (
        <s-section heading="Error">

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >

            <s-paragraph>
              {
                fetcher.data
                  .error
              }
            </s-paragraph>

          </s-box>

        </s-section>
      ) : null}

      {transferData ? (
        <s-section heading="Transfer Created">

          <s-stack
            direction="block"
            gap="base"
          >

            <s-heading>
              {
                transferData
                  .transfer
                  .referenceName ??
                transferData
                  .transfer
                  .name
              }
            </s-heading>

            <s-paragraph>
              <strong>
                Shopify Transfer:
              </strong>{" "}
              {
                transferData
                  .transfer
                  .name
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Status:
              </strong>{" "}
              {
                transferData
                  .transfer
                  .status
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Direction:
              </strong>{" "}
              {
                transferData
                  .transfer
                  .origin
              }
              {" → "}
              {
                transferData
                  .transfer
                  .destination
              }
            </s-paragraph>

            <s-button
              href={
                transferData
                  .transfer
                  .adminUrl
              }
              target="_blank"
            >
              View transfer
            </s-button>

            <s-divider />

            <s-heading>
              Transferred Products
            </s-heading>

            {transferData.items.map(
              (item) => (
                <s-box
                  key={item.sku}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >

                  <s-stack
                    direction="inline"
                    gap="base"
                  >

                    <span>
                      <strong>
                        {item.sku}
                      </strong>
                    </span>

                    <span>
                      Quantity:{" "}
                      {
                        item.quantity
                      }
                    </span>

                  </s-stack>

                </s-box>
              ),
            )}

          </s-stack>

        </s-section>
      ) : null}

    </s-page>
  );
}

// ============================================================
// HEADERS
// ============================================================

export const headers: HeadersFunction = (
  headersArgs,
) => {
  return boundary.headers(
    headersArgs,
  );
};
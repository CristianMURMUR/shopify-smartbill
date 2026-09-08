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
//
// IMPORTANT:
// Location is identified ONLY from:
//
// "Adresa de livrare:"
//
// CASE-SENSITIVE matching:
//
// "Calea Floreasca" -> Magazin Promenada
// "Calea Rahovei"   -> Sediu Principal
//
// These IDs are intentionally hardcoded and are NOT changed.
//
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

  const storeHandle = shop.replace(
    ".myshopify.com",
    "",
  );

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
// DEBUG HELPER
// ============================================================

function debugError(
  label: string,
  error: unknown,
) {
  console.error(`\n========== ${label} ==========`);

  if (error instanceof Error) {
    console.error("Error message:", error.message);
    console.error("Error name:", error.name);

    if (error.stack) {
      console.error("Error stack:");
      console.error(error.stack);
    }
  } else {
    console.error("Unknown error:", error);
  }

  console.error(`========== END ${label} ==========\n`);
}

// ============================================================
// LOADER
// ============================================================

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  console.log("[SMARTBILL] LOADER START");

  await authenticate.admin(request);

  console.log("[SMARTBILL] LOADER AUTH OK");

  return {};
};

// ============================================================
// ADDRESS NORMALIZATION
// ============================================================
//
// IMPORTANT:
// NO lowercase.
// Matching remains CASE-SENSITIVE.
//
// ============================================================

function normalizeDeliveryAddress(
  value: string,
) {
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
// ONLY deliveryAddress is used.
//
// ============================================================

function getDestinationLocation(
  deliveryAddress: string,
): TransferLocation | null {
  const normalizedAddress =
    normalizeDeliveryAddress(
      deliveryAddress,
    );

  console.log(
    "[LOCATION DEBUG] Original delivery address:",
    deliveryAddress,
  );

  console.log(
    "[LOCATION DEBUG] Normalized delivery address:",
    normalizedAddress,
  );

  console.log(
    "[LOCATION DEBUG] Promenada keyword:",
    LOCATION_PROMENADA.deliveryAddressKeyword,
  );

  console.log(
    "[LOCATION DEBUG] Sediu keyword:",
    LOCATION_SEDIU.deliveryAddressKeyword,
  );

  const promenadaMatch =
    normalizedAddress.includes(
      LOCATION_PROMENADA.deliveryAddressKeyword,
    );

  const sediuMatch =
    normalizedAddress.includes(
      LOCATION_SEDIU.deliveryAddressKeyword,
    );

  console.log(
    "[LOCATION DEBUG] Calea Floreasca match:",
    promenadaMatch,
  );

  console.log(
    "[LOCATION DEBUG] Calea Rahovei match:",
    sediuMatch,
  );

  if (promenadaMatch) {
    console.log(
      "[LOCATION DEBUG] DESTINATION = Magazin Promenada",
    );

    return {
      id: LOCATION_PROMENADA.id,
      name: LOCATION_PROMENADA.name,
    };
  }

  if (sediuMatch) {
    console.log(
      "[LOCATION DEBUG] DESTINATION = Sediu Principal",
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
  console.log(
    "\n========== PARSE AVIZ START ==========",
  );

  console.log(
    "[PARSE DEBUG] Input text length:",
    text.length,
  );

  console.log(
    "[PARSE DEBUG] First 3000 characters:",
  );

  console.log(
    text.slice(0, 3000),
  );

  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  console.log(
    "[PARSE DEBUG] Normalized text length:",
    normalized.length,
  );

  // ----------------------------------------------------------
  // DELIVERY NOTE NUMBER
  // ----------------------------------------------------------

  console.log(
    "[PARSE DEBUG] Looking for delivery note number...",
  );

  const numberMatch = normalized.match(
    /\b(AVIZ[A-Z0-9-]+)\b/i,
  );

  console.log(
    "[PARSE DEBUG] Number match:",
    numberMatch?.[0] ?? null,
  );

  if (!numberMatch) {
    throw new Error(
      "Could not identify the delivery note number.",
    );
  }

  // ----------------------------------------------------------
  // DATE
  // ----------------------------------------------------------

  console.log(
    "[PARSE DEBUG] Looking for date...",
  );

  const dateMatch = normalized.match(
    /Data\s+emiterii\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i,
  );

  console.log(
    "[PARSE DEBUG] Date match:",
    dateMatch?.[0] ?? null,
  );

  if (!dateMatch) {
    throw new Error(
      "Could not identify the delivery note date.",
    );
  }

  const date =
    `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

  console.log(
    "[PARSE DEBUG] Parsed date:",
    date,
  );

  // ----------------------------------------------------------
  // DELIVERY ADDRESS
  // ----------------------------------------------------------
  //
  // VERY IMPORTANT:
  //
  // We extract ONLY the value after:
  //
  // "Adresa de livrare:"
  //
  // We do NOT use normal "Adresa:".
  //
  // ----------------------------------------------------------

  console.log(
    "[PARSE DEBUG] Looking for 'Adresa de livrare:'...",
  );

  const deliveryAddressMatch =
    normalized.match(
      /Adresa\s+de\s+livrare:\s*([\s\S]*?)(?=\nIBAN|\nBanca:|\nAdresa:|\nCIF:|\nReg\.\s*com\.|\nNr\.\s*crt|$)/i,
    );

  console.log(
    "[PARSE DEBUG] Delivery address regex matched:",
    Boolean(deliveryAddressMatch),
  );

  if (deliveryAddressMatch) {
    console.log(
      "[PARSE DEBUG] Raw delivery address captured:",
      deliveryAddressMatch[1],
    );
  }

  if (!deliveryAddressMatch) {
    throw new Error(
      "Could not identify the delivery address.",
    );
  }

  const deliveryAddress =
    deliveryAddressMatch[1]
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "[PARSE DEBUG] Final delivery address:",
    deliveryAddress,
  );

  if (!deliveryAddress) {
    throw new Error(
      "The delivery address is empty.",
    );
  }

  // ----------------------------------------------------------
  // SKU + QUANTITY
  // ----------------------------------------------------------

  console.log(
    "[PARSE DEBUG] Looking for SKU codes...",
  );

  const skuMatches = [
    ...normalized.matchAll(
      /\(([A-Z0-9][A-Z0-9-]{5,})\)/gi,
    ),
  ];

  console.log(
    "[PARSE DEBUG] SKU matches found:",
    skuMatches.length,
  );

  console.log(
    "[PARSE DEBUG] SKU values:",
    skuMatches.map(
      (match) => match[1],
    ),
  );

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

    console.log(
      `\n[PARSE DEBUG] Processing SKU ${sku}`,
    );

    console.log(
      "[PARSE DEBUG] SKU block:",
      block.slice(0, 1000),
    );

    const quantityMatch =
      block.match(
        /\bbuc\s+(\d+(?:[.,]\d+)?)\b/i,
      );

    console.log(
      "[PARSE DEBUG] Quantity match:",
      quantityMatch?.[0] ?? null,
    );

    if (!quantityMatch) {
      throw new Error(
        `Could not identify the quantity for SKU ${sku}.`,
      );
    }

    const quantity =
      Number(
        quantityMatch[1].replace(
          ",",
          ".",
        ),
      );

    console.log(
      "[PARSE DEBUG] Parsed quantity:",
      quantity,
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

  const parsed: ParsedAviz = {
    number:
      numberMatch[1].toUpperCase(),
    date,
    deliveryAddress,
    items,
  };

  console.log(
    "\n[PARSE DEBUG] FINAL PARSED AVIZ:",
  );

  console.log(
    JSON.stringify(
      parsed,
      null,
      2,
    ),
  );

  console.log(
    "========== PARSE AVIZ END ==========\n",
  );

  return parsed;
}

// ============================================================
// PDF TEXT EXTRACTION
// ============================================================

async function extractPdfText(
  file: File,
) {
  const started =
    performance.now();

  console.log(
    "\n========== PDF EXTRACTION START ==========",
  );

  console.log(
    "[PDF DEBUG] File name:",
    file.name,
  );

  console.log(
    "[PDF DEBUG] File type:",
    file.type,
  );

  console.log(
    "[PDF DEBUG] File size:",
    file.size,
  );

  console.log(
    "[PDF DEBUG] Converting file to ArrayBuffer...",
  );

  const arrayBuffer =
    await file.arrayBuffer();

  console.log(
    "[PDF DEBUG] ArrayBuffer created:",
    arrayBuffer.byteLength,
    "bytes",
  );

  const buffer =
    Buffer.from(arrayBuffer);

  console.log(
    "[PDF DEBUG] Buffer created:",
    buffer.length,
    "bytes",
  );

  console.log(
    "[PDF DEBUG] First bytes:",
    buffer
      .subarray(0, 20)
      .toString("hex"),
  );

  console.log(
    "[PDF DEBUG] Importing pdf-parse...",
  );

  let PDFParse: any;

  try {
    const pdfParseModule =
      await import("pdf-parse");

    console.log(
      "[PDF DEBUG] pdf-parse module imported successfully.",
    );

    console.log(
      "[PDF DEBUG] pdf-parse module keys:",
      Object.keys(
        pdfParseModule,
      ),
    );

    PDFParse =
      pdfParseModule.PDFParse;

    if (!PDFParse) {
      throw new Error(
        "PDFParse was not found in pdf-parse module.",
      );
    }
  } catch (error) {
    debugError(
      "PDF-PARSE IMPORT ERROR",
      error,
    );

    throw new Error(
      `Could not load PDF parser: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  console.log(
    "[PDF DEBUG] Creating PDFParse instance...",
  );

  let parser: any;

  try {
    parser = new PDFParse({
      data: buffer,
    });

    console.log(
      "[PDF DEBUG] PDFParse instance created.",
    );
  } catch (error) {
    debugError(
      "PDF-PARSE CONSTRUCTOR ERROR",
      error,
    );

    throw new Error(
      `Could not initialize PDF parser: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  try {
    console.log(
      "[PDF DEBUG] Calling parser.getText()...",
    );

    const result =
      await parser.getText();

    console.log(
      "[PDF DEBUG] parser.getText() completed.",
    );

    console.log(
      "[PDF DEBUG] Extraction time:",
      `${(
        performance.now() -
        started
      ).toFixed(0)} ms`,
    );

    console.log(
      "[PDF DEBUG] Extracted text length:",
      result.text.length,
    );

    console.log(
      "[PDF DEBUG] Extracted text preview:",
    );

    console.log(
      result.text.slice(
        0,
        3000,
      ),
    );

    console.log(
      "========== PDF EXTRACTION END ==========\n",
    );

    return result.text;
  } catch (error) {
    debugError(
      "PDF getText() ERROR",
      error,
    );

    throw new Error(
      `Could not extract text from PDF: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  } finally {
    console.log(
      "[PDF DEBUG] Destroying PDF parser...",
    );

    try {
      await parser.destroy();

      console.log(
        "[PDF DEBUG] PDF parser destroyed.",
      );
    } catch (error) {
      debugError(
        "PDF parser destroy error",
        error,
      );
    }
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
    `\n[SHOPIFY SKU DEBUG] START SKU LOOKUP: ${sku}`,
  );

  const query =
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
    `;

  console.log(
    "[SHOPIFY SKU DEBUG] Query:",
    `sku:${sku}`,
  );

  let response: any;

  try {
    response =
      await admin.graphql(
        query,
        {
          variables: {
            query: `sku:${sku}`,
          },
        },
      );

    console.log(
      "[SHOPIFY SKU DEBUG] GraphQL request completed.",
    );
  } catch (error) {
    debugError(
      `SHOPIFY SKU GRAPHQL REQUEST ERROR ${sku}`,
      error,
    );

    throw new Error(
      `Shopify SKU lookup failed for ${sku}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  console.log(
    "[SHOPIFY SKU DEBUG] HTTP status:",
    response.status,
  );

  let json: any;

  try {
    json =
      await response.json();

    console.log(
      "[SHOPIFY SKU DEBUG] JSON received:",
    );

    console.log(
      JSON.stringify(
        json,
        null,
        2,
      ),
    );
  } catch (error) {
    debugError(
      `SHOPIFY SKU JSON ERROR ${sku}`,
      error,
    );

    throw new Error(
      `Shopify returned invalid JSON for SKU ${sku}.`,
    );
  }

  if (json.errors) {
    console.error(
      `[SHOPIFY SKU DEBUG] GRAPHQL ERRORS FOR ${sku}:`,
      JSON.stringify(
        json.errors,
        null,
        2,
      ),
    );

    throw new Error(
      `Shopify SKU lookup failed for ${sku}.`,
    );
  }

  const nodes =
    json.data
      ?.productVariants
      ?.nodes ?? [];

  console.log(
    `[SHOPIFY SKU DEBUG] Found ${nodes.length} candidate variants for ${sku}.`,
  );

  const variant =
    nodes.find(
      (node: any) =>
        node.sku?.toUpperCase() ===
        sku.toUpperCase(),
    );

  if (!variant) {
    console.error(
      `[SHOPIFY SKU DEBUG] EXACT SKU NOT FOUND: ${sku}`,
    );

    console.error(
      "[SHOPIFY SKU DEBUG] Candidates:",
      JSON.stringify(
        nodes,
        null,
        2,
      ),
    );

    throw new Error(
      `SKU ${sku} was not found in Shopify.`,
    );
  }

  console.log(
    `[SHOPIFY SKU DEBUG] Exact SKU found: ${sku}`,
  );

  console.log(
    "[SHOPIFY SKU DEBUG] Product:",
    variant.product?.title,
  );

  console.log(
    "[SHOPIFY SKU DEBUG] Variant:",
    variant.title,
  );

  console.log(
    "[SHOPIFY SKU DEBUG] Inventory Item ID:",
    variant.inventoryItem?.id,
  );

  if (
    !variant.inventoryItem?.id
  ) {
    throw new Error(
      `SKU ${sku} does not have an Inventory Item in Shopify.`,
    );
  }

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
// ACTION
// ============================================================

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  console.log(
    "\n\n============================================================",
  );

  console.log(
    "[SMARTBILL] ACTION START",
    new Date().toISOString(),
  );

  console.log(
    "[SMARTBILL] Request method:",
    request.method,
  );

  console.log(
    "[SMARTBILL] Request URL:",
    request.url,
  );

  console.log(
    "============================================================",
  );

  const { admin, session } =
    await authenticate.admin(request);

  console.log(
    "[SMARTBILL] Shopify authentication successful.",
  );

  console.log(
    "[SMARTBILL] Shop:",
    session.shop,
  );

  try {
    const formData =
      await request.formData();

    console.log(
      "[SMARTBILL] FormData received.",
    );

    console.log(
      "[SMARTBILL] FormData keys:",
      Array.from(
        formData.keys(),
      ),
    );

    const createTransfer =
      formData.get(
        "createTransfer",
      ) === "true";

    console.log(
      "[SMARTBILL] createTransfer:",
      createTransfer,
    );

    // ========================================================
    // CREATE TRANSFER
    // ========================================================

    if (createTransfer) {
      console.log(
        "\n========== CREATE TRANSFER START ==========",
      );

      const transferDataRaw =
        formData.get(
          "transferData",
        );

      console.log(
        "[TRANSFER DEBUG] transferData exists:",
        typeof transferDataRaw ===
          "string",
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

      console.log(
        "[TRANSFER DEBUG] transferData length:",
        transferDataRaw.length,
      );

      console.log(
        "[TRANSFER DEBUG] Raw transferData:",
        transferDataRaw,
      );

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
      } catch (error) {
        debugError(
          "TRANSFER DATA JSON PARSE ERROR",
          error,
        );

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

      console.log(
        "[TRANSFER DEBUG] Parsed transfer data:",
      );

      console.log(
        JSON.stringify(
          transferData,
          null,
          2,
        ),
      );

      if (
        !aviz?.number ||
        !originLocation?.id ||
        !destinationLocation?.id ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        console.error(
          "[TRANSFER DEBUG] INCOMPLETE TRANSFER DATA",
        );

        return {
          ok: false,
          error:
            "Incomplete data for creating the transfer.",
          details: transferData,
        };
      }

      // ------------------------------------------------------
      // DUPLICATE CHECK
      // ------------------------------------------------------

      console.log(
        "[TRANSFER DEBUG] Checking duplicate import...",
      );

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

      console.log(
        "[TRANSFER DEBUG] Existing import:",
        existingImport
          ? JSON.stringify(
              existingImport,
              null,
              2,
            )
          : "NONE",
      );

      if (existingImport) {
        return {
          ok: false,
          error:
            `Delivery note ${aviz.number} has already been imported as ${existingImport.transferName}.`,
        };
      }

      // ------------------------------------------------------
      // TRANSFER DATA DEBUG
      // ------------------------------------------------------

      console.log(
        "\n========== TRANSFER DATA ==========",
      );

      console.log(
        "Delivery note:",
        aviz.number,
      );

      console.log(
        "Delivery date:",
        aviz.date,
      );

      console.log(
        "Delivery address:",
        aviz.deliveryAddress,
      );

      console.log(
        "Origin:",
        originLocation.name,
      );

      console.log(
        "Origin ID:",
        originLocation.id,
      );

      console.log(
        "Destination:",
        destinationLocation.name,
      );

      console.log(
        "Destination ID:",
        destinationLocation.id,
      );

      console.log(
        "Products:",
        items.length,
      );

      console.log(
        "Products detail:",
        JSON.stringify(
          items,
          null,
          2,
        ),
      );

      console.log(
        "==================================\n",
      );

      // ------------------------------------------------------
      // IDEMPOTENCY KEY
      // ------------------------------------------------------

      const idempotencyKey =
        `smartbill-${session.shop}-${aviz.number}`;

      console.log(
        "[TRANSFER DEBUG] Idempotency key:",
        idempotencyKey,
      );

      const mutation =
        `#graphql
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
              }
            }
          }
        `;

      const input = {
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
        lineItems:
          items.map(
            (item) => ({
              inventoryItemId:
                item.inventoryItemId,
              quantity:
                item.quantity,
            }),
          ),
      };

      console.log(
        "\n========== SHOPIFY TRANSFER REQUEST ==========",
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Origin location ID:",
        input.originLocationId,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Destination location ID:",
        input.destinationLocationId,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Reference:",
        input.referenceName,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Date:",
        input.dateCreated,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Note:",
        input.note,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] Line items:",
        JSON.stringify(
          input.lineItems,
          null,
          2,
        ),
      );

      console.log(
        "==============================================\n",
      );

      console.log(
        "[SMARTBILL] BEFORE SHOPIFY CREATE",
        new Date().toISOString(),
      );

      const started =
        performance.now();

      let response: any;

      try {
        response =
          await admin.graphql(
            mutation,
            {
              variables: {
                input,
                idempotencyKey,
              },
            },
          );

        console.log(
          "[SHOPIFY TRANSFER DEBUG] GraphQL request completed.",
        );
      } catch (error) {
        debugError(
          "SHOPIFY TRANSFER GRAPHQL REQUEST ERROR",
          error,
        );

        return {
          ok: false,
          error:
            "Shopify GraphQL request failed while creating the transfer.",
          details:
            error instanceof Error
              ? {
                  message:
                    error.message,
                  stack:
                    error.stack,
                }
              : error,
        };
      }

      console.log(
        `[SMARTBILL] inventoryTransferCreate request time: ${(performance.now() - started).toFixed(0)} ms`,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] HTTP status:",
        response.status,
      );

      console.log(
        "[SHOPIFY TRANSFER DEBUG] HTTP status text:",
        response.statusText,
      );

      let json: any;

      try {
        json =
          await response.json();

        console.log(
          "\n========== SHOPIFY RAW RESPONSE ==========",
        );

        console.log(
          JSON.stringify(
            json,
            null,
            2,
          ),
        );

        console.log(
          "==========================================\n",
        );
      } catch (error) {
        debugError(
          "SHOPIFY TRANSFER JSON PARSE ERROR",
          error,
        );

        return {
          ok: false,
          error:
            "Shopify returned an invalid response while creating the transfer.",
          details:
            error instanceof Error
              ? error.message
              : error,
        };
      }

      // ------------------------------------------------------
      // GRAPHQL ERRORS
      // ------------------------------------------------------

      if (json.errors) {
        console.error(
          "\n========== SHOPIFY GRAPHQL ERRORS ==========",
        );

        console.error(
          JSON.stringify(
            json.errors,
            null,
            2,
          ),
        );

        console.error(
          "============================================\n",
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
          "[SHOPIFY TRANSFER DEBUG] No inventoryTransferCreate result.",
        );

        console.error(
          "[SHOPIFY TRANSFER DEBUG] Full response:",
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

      console.log(
        "[SHOPIFY TRANSFER DEBUG] userErrors:",
      );

      console.log(
        JSON.stringify(
          result.userErrors ?? [],
          null,
          2,
        ),
      );

      if (
        result.userErrors?.length
      ) {
        console.error(
          "\n============================================================",
        );

        console.error(
          "SHOPIFY TRANSFER CREATION USER ERRORS:",
        );

        console.error(
          JSON.stringify(
            result.userErrors,
            null,
            2,
          ),
        );

        console.error(
          "============================================================\n",
        );

        return {
          ok: false,
          error:
            "Shopify rejected the transfer creation.",
          details:
            result.userErrors,
        };
      }

      // ------------------------------------------------------
      // TRANSFER RESULT
      // ------------------------------------------------------

      if (
        !result.inventoryTransfer
      ) {
        console.error(
          "[SHOPIFY TRANSFER DEBUG] inventoryTransfer is NULL.",
        );

        console.error(
          "[SHOPIFY TRANSFER DEBUG] Result:",
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

      const transfer =
        result.inventoryTransfer;

      console.log(
        "\n========== SHOPIFY TRANSFER CREATED ==========",
      );

      console.log(
        "Transfer ID:",
        transfer.id,
      );

      console.log(
        "Transfer name:",
        transfer.name,
      );

      console.log(
        "Status:",
        transfer.status,
      );

      console.log(
        "Reference:",
        transfer.referenceName,
      );

      console.log(
        "Origin:",
        transfer.origin?.name,
      );

      console.log(
        "Destination:",
        transfer.destination?.name,
      );

      console.log(
        "==============================================\n",
      );

      const adminUrl =
        getTransferAdminUrl(
          session.shop,
          transfer.id,
        );

      console.log(
        "[TRANSFER DEBUG] Admin URL:",
        adminUrl,
      );

      // ------------------------------------------------------
      // SAVE IMPORT HISTORY
      // ------------------------------------------------------

      console.log(
        "[TRANSFER DEBUG] Saving import history...",
      );

      try {
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
          "[TRANSFER DEBUG] Import history saved successfully.",
        );
      } catch (error) {
        debugError(
          "PRISMA IMPORT HISTORY ERROR",
          error,
        );

        return {
          ok: false,
          error:
            "Transfer was created in Shopify, but saving import history failed.",
          details:
            error instanceof Error
              ? {
                  message:
                    error.message,
                  stack:
                    error.stack,
                }
              : error,
        };
      }

      console.log(
        "[SMARTBILL] BEFORE RESPONSE",
        new Date().toISOString(),
      );

      console.log(
        "========== CREATE TRANSFER END ==========\n",
      );

      return {
        ok: true,
        mode: "transfer",
        transfer: {
          id: transfer.id,
          name: transfer.name,
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

    console.log(
      "\n========== PREVIEW START ==========",
    );

    const file =
      formData.get("pdf");

    console.log(
      "[SMARTBILL] PDF form field exists:",
      Boolean(file),
    );

    if (!(file instanceof File)) {
      console.error(
        "[SMARTBILL] PDF field is not a File.",
      );

      return {
        ok: false,
        error:
          "No PDF file was selected.",
      };
    }

    console.log(
      "[SMARTBILL] PDF file:",
      file.name,
    );

    console.log(
      "[SMARTBILL] PDF MIME:",
      file.type,
    );

    console.log(
      "[SMARTBILL] PDF size:",
      file.size,
    );

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
      "=== SMARTBILL PDF IMPORT START ===",
    );

    // --------------------------------------------------------
    // 1. EXTRACT PDF TEXT
    // --------------------------------------------------------

    console.log(
      "[SMARTBILL] STEP 1: PDF TEXT EXTRACTION",
    );

    let avizText: string;

    try {
      avizText =
        await extractPdfText(file);
    } catch (error) {
      debugError(
        "PDF EXTRACTION FAILED",
        error,
      );

      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not extract text from PDF.",
        details:
          error instanceof Error
            ? {
                message:
                  error.message,
                stack:
                  error.stack,
              }
            : error,
      };
    }

    console.log(
      "[SMARTBILL] STEP 1 COMPLETE",
    );

    if (!avizText.trim()) {
      console.error(
        "[SMARTBILL] PDF returned EMPTY TEXT.",
      );

      return {
        ok: false,
        error:
          "The PDF does not contain extractable text.",
      };
    }

    // --------------------------------------------------------
    // 2. PARSE
    // --------------------------------------------------------

    console.log(
      "[SMARTBILL] STEP 2: PARSING AVIZ",
    );

    let aviz: ParsedAviz;

    try {
      aviz =
        parseAviz(
          avizText,
        );
    } catch (error) {
      debugError(
        "AVIZ PARSE FAILED",
        error,
      );

      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not parse the delivery note.",
        details:
          error instanceof Error
            ? {
                message:
                  error.message,
                stack:
                  error.stack,
              }
            : error,
      };
    }

    console.log(
      "[SMARTBILL] STEP 2 COMPLETE",
    );

    console.log(
      "[SMARTBILL] Parsed aviz:",
      JSON.stringify(
        aviz,
        null,
        2,
      ),
    );

    // --------------------------------------------------------
    // 3. CHECK DUPLICATE
    // --------------------------------------------------------

    console.log(
      "[SMARTBILL] STEP 3: DUPLICATE CHECK",
    );

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
        "[SMARTBILL] DUPLICATE FOUND:",
        JSON.stringify(
          existingImport,
          null,
          2,
        ),
      );

      return {
        ok: false,
        error:
          `Delivery note ${aviz.number} has already been imported as ${existingImport.transferName}.`,
      };
    }

    console.log(
      "[SMARTBILL] STEP 3 COMPLETE - NOT IMPORTED BEFORE",
    );

    // --------------------------------------------------------
    // 4. IDENTIFY DESTINATION
    // --------------------------------------------------------

    console.log(
      "\n[SMARTBILL] STEP 4: LOCATION DETECTION",
    );

    console.log(
      "[LOCATION DEBUG] ONLY delivery address will be used.",
    );

    console.log(
      "[LOCATION DEBUG] deliveryAddress:",
      aviz.deliveryAddress,
    );

    const destinationLocation =
      getDestinationLocation(
        aviz.deliveryAddress,
      );

    if (!destinationLocation) {
      console.error(
        "[LOCATION DEBUG] FAILED TO IDENTIFY DESTINATION.",
      );

      return {
        ok: false,
        error:
          "The delivery address does not contain a valid location keyword. Expected case-sensitive 'Calea Floreasca' for Magazin Promenada or 'Calea Rahovei' for Sediu Principal.",
        details: {
          deliveryAddress:
            aviz.deliveryAddress,
          expectedKeywords: {
            promenada:
              LOCATION_PROMENADA.deliveryAddressKeyword,
            sediu:
              LOCATION_SEDIU.deliveryAddressKeyword,
          },
        },
      };
    }

    // --------------------------------------------------------
    // 5. ORIGIN = OTHER LOCATION
    // --------------------------------------------------------

    const originLocation =
      getOriginLocation(
        destinationLocation,
      );

    console.log(
      "\n========== TRANSFER DIRECTION ==========",
    );

    console.log(
      "Delivery address:",
      aviz.deliveryAddress,
    );

    console.log(
      "Origin:",
      originLocation.name,
    );

    console.log(
      "Origin ID:",
      originLocation.id,
    );

    console.log(
      "Destination:",
      destinationLocation.name,
    );

    console.log(
      "Destination ID:",
      destinationLocation.id,
    );

    console.log(
      "========================================\n",
    );

    // --------------------------------------------------------
    // 6. SKU LOOKUP
    // --------------------------------------------------------

    console.log(
      "[SMARTBILL] STEP 6: SHOPIFY SKU LOOKUP",
    );

    const skuStarted =
      performance.now();

    try {
      const foundItems =
        await Promise.all(
          aviz.items.map(
            async (item) => {
              console.log(
                `[SHOPIFY SKU DEBUG] Looking up ${item.sku}...`,
              );

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
        `[SMARTBILL] Shopify SKU lookup total: ${(performance.now() - skuStarted).toFixed(0)} ms`,
      );

      console.log(
        "[SMARTBILL] Found items:",
        JSON.stringify(
          foundItems,
          null,
          2,
        ),
      );

      console.log(
        "[SMARTBILL] ALL SKUs WERE FOUND.",
      );

      console.log(
        "[SMARTBILL] BEFORE RESPONSE",
        new Date().toISOString(),
      );

      console.log(
        "========== PREVIEW END ==========\n",
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
      debugError(
        "SHOPIFY SKU LOOKUP FAILED",
        error,
      );

      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while looking up products in Shopify.",
        details:
          error instanceof Error
            ? {
                message:
                  error.message,
                stack:
                  error.stack,
              }
            : error,
      };
    }
  } catch (error) {
    debugError(
      "SMARTBILL IMPORT UNEXPECTED ERROR",
      error,
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while processing the PDF.",
      details:
        error instanceof Error
          ? {
              message:
                error.message,
              stack:
                error.stack,
            }
          : error,
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

  // ==========================================================
  // FRONTEND DEBUG
  // ==========================================================

  useEffect(() => {
    if (!fetcher.data) {
      return;
    }

    console.log(
      "[SMARTBILL FRONTEND DEBUG] fetcher.data:",
      fetcher.data,
    );

    if (
      !fetcher.data.ok
    ) {
      console.error(
        "[SMARTBILL FRONTEND DEBUG] SERVER ERROR:",
        fetcher.data.error,
      );

      console.error(
        "[SMARTBILL FRONTEND DEBUG] SERVER DETAILS:",
        fetcher.data.details,
      );
    }
  }, [
    fetcher.data,
  ]);

  // ==========================================================
  // TOASTS
  // ==========================================================

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
  // AUTOMATIC PDF UPLOAD
  // ==========================================================

  const uploadPdf = (
    selectedFile: File,
  ) => {
    console.log(
      "[SMARTBILL FRONTEND] Uploading PDF:",
      selectedFile.name,
      selectedFile.size,
      selectedFile.type,
    );

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
    console.log(
      "[SMARTBILL FRONTEND] CREATE TRANSFER CLICKED",
    );

    if (!previewData) {
      console.error(
        "[SMARTBILL FRONTEND] No previewData available.",
      );

      return;
    }

    const destinationLocation =
      getDestinationLocation(
        previewData.aviz
          .deliveryAddress,
      );

    if (!destinationLocation) {
      console.error(
        "[SMARTBILL FRONTEND] Could not identify destination.",
      );

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
      "[SMARTBILL FRONTEND] Transfer origin:",
      originLocation,
    );

    console.log(
      "[SMARTBILL FRONTEND] Transfer destination:",
      destinationLocation,
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
      {/* ====================================================
          IMPORT
      ==================================================== */}

      <s-section
        heading="Import SmartBill Delivery Note"
      >
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

      {/* ====================================================
          PREVIEW
      ==================================================== */}

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

      {/* ====================================================
          ERROR
      ==================================================== */}

      {fetcher.data &&
      !fetcher.data.ok ? (
        <s-section
          heading="Error"
        >
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

            {fetcher.data.details ? (
              <s-box
                padding="small"
                borderWidth="base"
                borderRadius="base"
              >
                <pre
                  style={{
                    whiteSpace:
                      "pre-wrap",
                    overflow:
                      "auto",
                    fontSize:
                      "12px",
                  }}
                >
                  {JSON.stringify(
                    fetcher.data
                      .details,
                    null,
                    2,
                  )}
                </pre>
              </s-box>
            ) : null}
          </s-box>
        </s-section>
      ) : null}

      {/* ====================================================
          TRANSFER CREATED
      ==================================================== */}

      {transferData ? (
        <s-section
          heading="Transfer Created"
        >
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
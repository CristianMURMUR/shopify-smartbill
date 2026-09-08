import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";

import {
  useFetcher,
  useLoaderData,
} from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ============================================================
// TYPES
// ============================================================

type TransferLocation = {
  id: string;
  name: string;
};

type ParsedItem = {
  sku: string;
  quantity: number;
  inventoryItemId?: string;
};

type ParsedAviz = {
  number: string;
  date: string;
  deliveryAddress: string;
  destinationLocation: TransferLocation | null;
  originLocation: TransferLocation | null;
  items: ParsedItem[];
};

type ActionResult = {
  ok: boolean;
  error?: string;
  details?: unknown;
  transfer?: {
    id: string;
    name: string;
    status?: string;
    referenceName?: string;
    origin?: {
      name: string;
    };
    destination?: {
      name: string;
    };
  };
};

// ============================================================
// SHOPIFY LOCATIONS
// ============================================================
//
// IMPORTANT:
// We keep the existing Shopify Location IDs.
// Location detection is based ONLY on "Adresa de livrare:".
//
// CASE-SENSITIVE:
// Calea Floreasca -> Magazin Promenada
// Calea Rahovei   -> Sediu Principal
//
// All other addresses -> no match
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
  const numericId =
    transferId.split("/").pop();

  const storeHandle =
    shop.replace(".myshopify.com", "");

  return numericId
    ? `https://admin.shopify.com/store/${storeHandle}/transfers/${numericId}`
    : `https://admin.shopify.com/store/${storeHandle}/transfers`;
}

// ============================================================
// ADDRESS NORMALIZATION
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
// DESTINATION LOCATION
// ============================================================
//
// IMPORTANT:
// This function receives ONLY the value extracted from:
// "Adresa de livrare:"
//
// It NEVER looks at:
// - Adresa:
// - supplier address
// - customer address
// - bank address
// - any other address
//
// Matching is CASE-SENSITIVE.
// ============================================================

function getDestinationLocation(
  deliveryAddress: string,
): TransferLocation | null {
  const normalizedAddress =
    normalizeDeliveryAddress(
      deliveryAddress,
    );

  console.log(
    "[SMARTBILL] LOCATION DETECTION - delivery address:",
    normalizedAddress,
  );

  console.log(
    "[SMARTBILL] LOCATION DETECTION - checking Promenada keyword:",
    LOCATION_PROMENADA.deliveryAddressKeyword,
  );

  if (
    normalizedAddress.includes(
      LOCATION_PROMENADA.deliveryAddressKeyword,
    )
  ) {
    console.log(
      "[SMARTBILL] LOCATION DETECTION - MATCH:",
      LOCATION_PROMENADA.name,
    );

    return {
      id: LOCATION_PROMENADA.id,
      name: LOCATION_PROMENADA.name,
    };
  }

  console.log(
    "[SMARTBILL] LOCATION DETECTION - checking Sediu keyword:",
    LOCATION_SEDIU.deliveryAddressKeyword,
  );

  if (
    normalizedAddress.includes(
      LOCATION_SEDIU.deliveryAddressKeyword,
    )
  ) {
    console.log(
      "[SMARTBILL] LOCATION DETECTION - MATCH:",
      LOCATION_SEDIU.name,
    );

    return {
      id: LOCATION_SEDIU.id,
      name: LOCATION_SEDIU.name,
    };
  }

  console.log(
    "[SMARTBILL] LOCATION DETECTION - NO MATCH",
  );

  return null;
}

// ============================================================
// ORIGIN LOCATION
// ============================================================
//
// The origin is always the other Shopify location.
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
// PDF TEXT EXTRACTION
// ============================================================

async function extractPdfText(
  buffer: Buffer,
): Promise<string> {
  console.log(
    "[SMARTBILL] PDF TEXT EXTRACTION START",
  );

  console.log(
    "[SMARTBILL] PDF buffer size:",
    buffer.length,
  );

  try {
    console.log(
      "[SMARTBILL] Importing pdf-parse...",
    );

    const pdfParseModule =
      await import("pdf-parse");

    console.log(
      "[SMARTBILL] pdf-parse imported.",
    );

    const pdfParse =
      pdfParseModule.default ||
      pdfParseModule;

    console.log(
      "[SMARTBILL] Creating PDF parser...",
    );

    const parser =
      new pdfParse.PDFParse({
        data: buffer,
      });

    console.log(
      "[SMARTBILL] Calling getText()...",
    );

    const result =
      await parser.getText();

    console.log(
      "[SMARTBILL] PDF getText() finished.",
    );

    const text =
      result?.text || "";

    console.log(
      "[SMARTBILL] Extracted PDF text length:",
      text.length,
    );

    console.log(
      "[SMARTBILL] PDF TEXT PREVIEW:\n",
      text.slice(0, 3000),
    );

    return text;
  } catch (error) {
    console.error(
      "[SMARTBILL] PDF TEXT EXTRACTION ERROR:",
      error,
    );

    if (error instanceof Error) {
      console.error(
        "[SMARTBILL] PDF ERROR MESSAGE:",
        error.message,
      );

      console.error(
        "[SMARTBILL] PDF ERROR STACK:",
        error.stack,
      );
    }

    throw error;
  }
}

// ============================================================
// PARSE SMARTBILL AVIZ
// ============================================================

function parseAviz(
  text: string,
): ParsedAviz {
  console.log(
    "[SMARTBILL] PARSING AVIZ START",
  );

  const normalized =
    text
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ");

  console.log(
    "[SMARTBILL] Normalized text length:",
    normalized.length,
  );

  // ----------------------------------------------------------
  // AVIZ NUMBER
  // ----------------------------------------------------------

  const numberMatch =
    normalized.match(
      /(?:Aviz|Avizul)\s*(?:nr\.?|num[aă]r)?\s*[:.]?\s*([A-Z0-9-]+)/i,
    );

  const avizNumber =
    numberMatch?.[1]?.trim() || "";

  console.log(
    "[SMARTBILL] Parsed AVIZ number:",
    avizNumber,
  );

  if (!avizNumber) {
    throw new Error(
      "Nu am putut identifica numărul AVIZ-ului din PDF.",
    );
  }

  // ----------------------------------------------------------
  // DATE
  // ----------------------------------------------------------

  const dateMatch =
    normalized.match(
      /Data\s+emiterii\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i,
    );

  let avizDate = "";

  if (dateMatch) {
    const [, day, month, year] =
      dateMatch;

    avizDate =
      `${year}-${month}-${day}`;
  }

  console.log(
    "[SMARTBILL] Parsed AVIZ date:",
    avizDate,
  );

  // ----------------------------------------------------------
  // DELIVERY ADDRESS
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // ONLY "Adresa de livrare:" is used.
  //
  // Plain "Adresa:" is deliberately NOT used.
  // ----------------------------------------------------------

  const deliveryAddressMatch =
    normalized.match(
      /Adresa\s+de\s+livrare:\s*([\s\S]*?)(?=\nIBAN|\nBanca:|\nAdresa:|\nCIF:|\nReg\.\s*com\.|\nNr\.\s*crt|$)/i,
    );

  const deliveryAddress =
    deliveryAddressMatch?.[1]
      ?.replace(/\s+/g, " ")
      .trim() || "";

  console.log(
    "[SMARTBILL] Parsed delivery address:",
    deliveryAddress,
  );

  if (!deliveryAddress) {
    throw new Error(
      'Nu am putut identifica "Adresa de livrare:" din PDF.',
    );
  }

  // ----------------------------------------------------------
  // LOCATION DETECTION
  // ----------------------------------------------------------

  const destinationLocation =
    getDestinationLocation(
      deliveryAddress,
    );

  if (!destinationLocation) {
    console.log(
      "[SMARTBILL] No destination location matched.",
    );
  } else {
    console.log(
      "[SMARTBILL] Destination location:",
      destinationLocation,
    );
  }

  const originLocation =
    destinationLocation
      ? getOriginLocation(
          destinationLocation,
        )
      : null;

  if (originLocation) {
    console.log(
      "[SMARTBILL] Origin location:",
      originLocation,
    );
  }

  // ----------------------------------------------------------
  // ITEMS / SKU
  // ----------------------------------------------------------

  console.log(
    "[SMARTBILL] Searching for SKU values...",
  );

  const skuMatches = [
    ...normalized.matchAll(
      /\(([A-Z0-9][A-Z0-9-]{5,})\)/gi,
    ),
  ];

  console.log(
    "[SMARTBILL] SKU matches found:",
    skuMatches.length,
  );

  const items: ParsedItem[] = [];

  for (
    let index = 0;
    index < skuMatches.length;
    index++
  ) {
    const match =
      skuMatches[index];

    const sku =
      match[1]?.trim();

    if (!sku) {
      continue;
    }

    const start =
      match.index ?? 0;

    const nextStart =
      skuMatches[index + 1]
        ?.index ??
      normalized.length;

    const block =
      normalized.slice(
        start,
        nextStart,
      );

    console.log(
      `[SMARTBILL] SKU ${index + 1} block:\n`,
      block.slice(0, 500),
    );

    const quantityMatch =
      block.match(
        /\bbuc\s+(\d+(?:[.,]\d+)?)\b/i,
      );

    if (!quantityMatch) {
      console.log(
        `[SMARTBILL] No quantity found for SKU ${sku}.`,
      );

      continue;
    }

    const quantity =
      Number(
        quantityMatch[1]
          .replace(",", "."),
      );

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      console.log(
        `[SMARTBILL] Invalid quantity for SKU ${sku}:`,
        quantityMatch[1],
      );

      continue;
    }

    items.push({
      sku,
      quantity,
    });

    console.log(
      "[SMARTBILL] Parsed item:",
      {
        sku,
        quantity,
      },
    );
  }

  console.log(
    "[SMARTBILL] Total parsed items:",
    items.length,
  );

  if (items.length === 0) {
    throw new Error(
      "Nu am putut identifica produsele/SKU-urile din PDF.",
    );
  }

  const result: ParsedAviz = {
    number: avizNumber,
    date: avizDate,
    deliveryAddress,
    destinationLocation,
    originLocation,
    items,
  };

  console.log(
    "[SMARTBILL] PARSED AVIZ RESULT:",
    JSON.stringify(
      result,
      null,
      2,
    ),
  );

  return result;
}

// ============================================================
// SHOPIFY INVENTORY ITEM LOOKUP
// ============================================================

async function findInventoryItemBySku(
  admin: any,
  sku: string,
) {
  console.log(
    "[SMARTBILL] Shopify SKU lookup START:",
    sku,
  );

  const query = `#graphql
    query FindInventoryItemBySku($query: String!) {
      productVariants(
        first: 10
        query: $query
      ) {
        nodes {
          id
          sku
          inventoryItem {
            id
          }
          product {
            id
            title
          }
        }
      }
    }
  `;

  const variables = {
    query: `sku:${sku}`,
  };

  console.log(
    "[SMARTBILL] SKU lookup variables:",
    JSON.stringify(
      variables,
      null,
      2,
    ),
  );

  try {
    const response =
      await admin.graphql(
        query,
        {
          variables,
        },
      );

    const json =
      await response.json();

    console.log(
      "[SMARTBILL] SKU lookup raw response:",
      JSON.stringify(
        json,
        null,
        2,
      ),
    );

    if (json.errors) {
      console.error(
        "[SMARTBILL] SKU lookup GraphQL errors:",
        JSON.stringify(
          json.errors,
          null,
          2,
        ),
      );
    }

    const nodes =
      json.data
        ?.productVariants
        ?.nodes || [];

    console.log(
      "[SMARTBILL] SKU lookup nodes count:",
      nodes.length,
    );

    const exactMatch =
      nodes.find(
        (node: any) =>
          node?.sku === sku,
      );

    if (!exactMatch) {
      console.log(
        "[SMARTBILL] No exact SKU match found:",
        sku,
      );

      return null;
    }

    console.log(
      "[SMARTBILL] Exact SKU match found:",
      JSON.stringify(
        exactMatch,
        null,
        2,
      ),
    );

    return exactMatch
      .inventoryItem?.id || null;
  } catch (error) {
    console.error(
      "[SMARTBILL] SKU lookup ERROR:",
      sku,
      error,
    );

    throw error;
  }
}

// ============================================================
// LOADER
// ============================================================

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  console.log(
    "[SMARTBILL] LOADER START",
  );

  const { session } =
    await authenticate.admin(request);

  console.log(
    "[SMARTBILL] LOADER SHOP:",
    session.shop,
  );

  const importHistory =
    await prisma.importHistory.findMany({
      where: {
        shop: session.shop,
      },

      orderBy: {
        createdAt: "desc",
      },
    });

  console.log(
    "[SMARTBILL] History entries:",
    importHistory.length,
  );

  return {
    importHistory:
      importHistory.map(
        (item) => ({
          id: item.id,
          avizNumber:
            item.avizNumber,
          transferId:
            item.transferId,
          transferName:
            item.transferName,
          createdAt:
            item.createdAt.toISOString(),
          transferUrl:
            getTransferAdminUrl(
              session.shop,
              item.transferId,
            ),
        }),
      ),
  };
};

// ============================================================
// ACTION
// ============================================================

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  console.log(
    "============================================================",
  );

  console.log(
    "[SMARTBILL] ACTION START",
  );

  const startedAt =
    Date.now();

  try {
    const { admin, session } =
      await authenticate.admin(
        request,
      );

    console.log(
      "[SMARTBILL] Authenticated shop:",
      session.shop,
    );

    const formData =
      await request.formData();

    const actionType =
      formData.get("action");

    console.log(
      "[SMARTBILL] Action type:",
      actionType,
    );

    // ========================================================
    // DELETE HISTORY
    // ========================================================

    if (
      actionType === "delete"
    ) {
      const id =
        formData.get("id");

      console.log(
        "[SMARTBILL] DELETE HISTORY REQUEST:",
        {
          id,
          shop: session.shop,
        },
      );

      if (
        typeof id !== "string" ||
        !id
      ) {
        return {
          ok: false,
          error:
            "Invalid transfer ID.",
        };
      }

      const historyEntry =
        await prisma.importHistory.findFirst({
          where: {
            id,
            shop: session.shop,
          },
        });

      if (!historyEntry) {
        return {
          ok: false,
          error:
            "Transfer history entry not found.",
        };
      }

      await prisma.importHistory.delete({
        where: {
          id: historyEntry.id,
        },
      });

      console.log(
        "[SMARTBILL] Transfer history deleted:",
        {
          shop: session.shop,
          id: historyEntry.id,
          avizNumber:
            historyEntry.avizNumber,
          transferName:
            historyEntry.transferName,
        },
      );

      return {
        ok: true,
      };
    }

    // ========================================================
    // CREATE TRANSFER
    // ========================================================

    if (
      actionType !== "createTransfer"
    ) {
      console.error(
        "[SMARTBILL] UNKNOWN ACTION:",
        actionType,
      );

      return {
        ok: false,
        error:
          "Unknown action.",
      };
    }

    console.log(
      "[SMARTBILL] CREATE TRANSFER BRANCH",
    );

    const file =
      formData.get("file");

    console.log(
      "[SMARTBILL] File received:",
      file instanceof File
        ? {
            name: file.name,
            size: file.size,
            type: file.type,
          }
        : typeof file,
    );

    if (!(file instanceof File)) {
      return {
        ok: false,
        error:
          "PDF file was not received.",
      };
    }

    if (
      file.size === 0
    ) {
      return {
        ok: false,
        error:
          "PDF file is empty.",
      };
    }

    // ========================================================
    // READ PDF
    // ========================================================

    console.log(
      "[SMARTBILL] Reading PDF buffer...",
    );

    const arrayBuffer =
      await file.arrayBuffer();

    const buffer =
      Buffer.from(arrayBuffer);

    console.log(
      "[SMARTBILL] PDF buffer created:",
      buffer.length,
    );

    const text =
      await extractPdfText(
        buffer,
      );

    console.log(
      "[SMARTBILL] PDF text extraction complete.",
    );

    // ========================================================
    // PARSE AVIZ
    // ========================================================

    const aviz =
      parseAviz(text);

    console.log(
      "[SMARTBILL] Parsed AVIZ:",
      JSON.stringify(
        aviz,
        null,
        2,
      ),
    );

    // ========================================================
    // LOCATION CHECK
    // ========================================================

    if (
      !aviz.destinationLocation
    ) {
      return {
        ok: false,
        error:
          'Nu am putut identifica locația destinație din "Adresa de livrare:". Sunt acceptate doar "Calea Floreasca" sau "Calea Rahovei".',
        details: {
          deliveryAddress:
            aviz.deliveryAddress,
        },
      };
    }

    if (
      !aviz.originLocation
    ) {
      return {
        ok: false,
        error:
          "Origin location could not be determined.",
      };
    }

    console.log(
      "[SMARTBILL] FINAL ORIGIN:",
      {
        id: aviz.originLocation.id,
        name: aviz.originLocation.name,
      },
    );

    console.log(
      "[SMARTBILL] FINAL DESTINATION:",
      {
        id: aviz.destinationLocation.id,
        name: aviz.destinationLocation.name,
      },
    );

    // ========================================================
    // DUPLICATE HISTORY CHECK
    // ========================================================

    console.log(
      "[SMARTBILL] Checking duplicate AVIZ in ImportHistory...",
    );

    const existingHistory =
      await prisma.importHistory.findFirst({
        where: {
          shop: session.shop,
          avizNumber: aviz.number,
        },
      });

    if (existingHistory) {
      console.log(
        "[SMARTBILL] DUPLICATE AVIZ FOUND:",
        existingHistory,
      );

      return {
        ok: false,
        error:
          `AVIZ ${aviz.number} has already been imported.`,
        details: {
          existingTransferId:
            existingHistory.transferId,
          existingTransferName:
            existingHistory.transferName,
        },
      };
    }

    console.log(
      "[SMARTBILL] No duplicate AVIZ found.",
    );

    // ========================================================
    // SKU -> INVENTORY ITEM ID
    // ========================================================

    const resolvedItems: ParsedItem[] =
      [];

    for (
      const item of aviz.items
    ) {
      console.log(
        "[SMARTBILL] Resolving SKU:",
        item.sku,
      );

      const inventoryItemId =
        await findInventoryItemBySku(
          admin,
          item.sku,
        );

      if (!inventoryItemId) {
        console.error(
          "[SMARTBILL] INVENTORY ITEM NOT FOUND:",
          item.sku,
        );

        return {
          ok: false,
          error:
            `SKU ${item.sku} was not found in Shopify.`,
          details: {
            sku: item.sku,
          },
        };
      }

      resolvedItems.push({
        ...item,
        inventoryItemId,
      });

      console.log(
        "[SMARTBILL] SKU resolved:",
        {
          sku: item.sku,
          inventoryItemId,
          quantity:
            item.quantity,
        },
      );
    }

    // ========================================================
    // FINAL LINE ITEMS
    // ========================================================

    const lineItems =
      resolvedItems.map(
        (item) => ({
          inventoryItemId:
            item.inventoryItemId!,
          quantity:
            item.quantity,
        }),
      );

    console.log(
      "[SMARTBILL] FINAL LINE ITEMS:",
      JSON.stringify(
        lineItems,
        null,
        2,
      ),
    );

    // ========================================================
    // IDEMPOTENCY KEY
    // ========================================================
    //
    // IMPORTANT:
    // New key for every manual attempt.
    //
    // The old implementation used only:
    // smartbill-shop-aviz
    //
    // After a failed Shopify request, retrying with exactly
    // the same idempotency key can return the previous failure.
    // ========================================================

    const idempotencyKey =
      `smartbill-${session.shop}-${aviz.number}-${crypto.randomUUID()}`;

    console.log(
      "[SMARTBILL] NEW IDEMPOTENCY KEY:",
      idempotencyKey,
    );

    // ========================================================
    // CREATE TRANSFER VARIABLES
    // ========================================================

    const input = {
      originLocationId:
        aviz.originLocation.id,

      destinationLocationId:
        aviz.destinationLocation.id,

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

    const variables = {
      input,
      idempotencyKey,
    };

    console.log(
      "[SMARTBILL] ==================================================",
    );

    console.log(
      "[SMARTBILL] CREATE TRANSFER VARIABLES:",
      JSON.stringify(
        variables,
        null,
        2,
      ),
    );

    console.log(
      "[SMARTBILL] ORIGIN LOCATION ID:",
      aviz.originLocation.id,
    );

    console.log(
      "[SMARTBILL] ORIGIN LOCATION NAME:",
      aviz.originLocation.name,
    );

    console.log(
      "[SMARTBILL] DESTINATION LOCATION ID:",
      aviz.destinationLocation.id,
    );

    console.log(
      "[SMARTBILL] DESTINATION LOCATION NAME:",
      aviz.destinationLocation.name,
    );

    console.log(
      "[SMARTBILL] REFERENCE NAME:",
      aviz.number,
    );

    console.log(
      "[SMARTBILL] DATE CREATED:",
      input.dateCreated,
    );

    console.log(
      "[SMARTBILL] LINE ITEMS COUNT:",
      lineItems.length,
    );

    console.log(
      "[SMARTBILL] ==================================================",
    );

    // ========================================================
    // SHOPIFY MUTATION
    // ========================================================

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

    console.log(
      "[SMARTBILL] Sending inventoryTransferCreate to Shopify...",
    );

    const shopifyStartedAt =
      Date.now();

    let response;

    try {
      response =
        await admin.graphql(
          mutation,
          {
            variables,
          },
        );
    } catch (error) {
      console.error(
        "[SMARTBILL] SHOPIFY GRAPHQL REQUEST ERROR:",
        error,
      );

      if (
        error instanceof Error
      ) {
        console.error(
          "[SMARTBILL] ERROR MESSAGE:",
          error.message,
        );

        console.error(
          "[SMARTBILL] ERROR STACK:",
          error.stack,
        );
      }

      return {
        ok: false,
        error:
          "Shopify GraphQL request failed.",
        details: {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      };
    }

    console.log(
      "[SMARTBILL] Shopify response received in:",
      Date.now() -
        shopifyStartedAt,
      "ms",
    );

    let json: any;

    try {
      json =
        await response.json();
    } catch (error) {
      console.error(
        "[SMARTBILL] FAILED TO PARSE SHOPIFY RESPONSE:",
        error,
      );

      return {
        ok: false,
        error:
          "Could not parse Shopify response.",
      };
    }

    // ========================================================
    // RAW SHOPIFY RESPONSE
    // ========================================================

    console.log(
      "[SMARTBILL] ==================================================",
    );

    console.log(
      "[SMARTBILL] SHOPIFY RAW RESPONSE:",
      JSON.stringify(
        json,
        null,
        2,
      ),
    );

    console.log(
      "[SMARTBILL] SHOPIFY GRAPHQL ERRORS:",
      JSON.stringify(
        json.errors || null,
        null,
        2,
      ),
    );

    const createResult =
      json.data
        ?.inventoryTransferCreate;

    console.log(
      "[SMARTBILL] INVENTORY TRANSFER CREATE RESULT:",
      JSON.stringify(
        createResult || null,
        null,
        2,
      ),
    );

    const userErrors =
      createResult
        ?.userErrors || [];

    console.log(
      "[SMARTBILL] SHOPIFY USER ERRORS:",
      JSON.stringify(
        userErrors,
        null,
        2,
      ),
    );

    const createdTransfer =
      createResult
        ?.inventoryTransfer;

    console.log(
      "[SMARTBILL] CREATED TRANSFER:",
      JSON.stringify(
        createdTransfer || null,
        null,
        2,
      ),
    );

    console.log(
      "[SMARTBILL] ==================================================",
    );

    // ========================================================
    // GRAPHQL TOP-LEVEL ERRORS
    // ========================================================

    if (
      Array.isArray(json.errors) &&
      json.errors.length > 0
    ) {
      console.error(
        "[SMARTBILL] TOP-LEVEL SHOPIFY GRAPHQL ERROR DETECTED.",
      );

      return {
        ok: false,
        error:
          "Shopify GraphQL returned an error.",
        details: {
          graphqlErrors:
            json.errors,
          userErrors,
        },
      };
    }

    // ========================================================
    // USER ERRORS
    // ========================================================

    if (
      userErrors.length > 0
    ) {
      console.error(
        "[SMARTBILL] SHOPIFY REJECTED TRANSFER CREATION.",
      );

      return {
        ok: false,
        error:
          "Shopify rejected the transfer creation.",
        details: {
          userErrors,
          input: {
            originLocationId:
              input.originLocationId,
            destinationLocationId:
              input.destinationLocationId,
            referenceName:
              input.referenceName,
            dateCreated:
              input.dateCreated,
            lineItems,
          },
          idempotencyKey,
        },
      };
    }

    // ========================================================
    // NO TRANSFER RETURNED
    // ========================================================

    if (
      !createdTransfer
    ) {
      console.error(
        "[SMARTBILL] SHOPIFY RETURNED NO TRANSFER AND NO USER ERRORS.",
      );

      return {
        ok: false,
        error:
          "Shopify did not return the created transfer.",
        details: {
          response: json,
          idempotencyKey,
        },
      };
    }

    // ========================================================
    // SAVE IMPORT HISTORY
    // ========================================================

    console.log(
      "[SMARTBILL] Saving transfer to ImportHistory...",
    );

    try {
      await prisma.importHistory.create({
        data: {
          shop:
            session.shop,

          avizNumber:
            aviz.number,

          transferId:
            createdTransfer.id,

          transferName:
            createdTransfer.name,
        },
      });

      console.log(
        "[SMARTBILL] ImportHistory saved successfully.",
      );
    } catch (error) {
      console.error(
        "[SMARTBILL] FAILED TO SAVE IMPORT HISTORY:",
        error,
      );

      if (
        error instanceof Error
      ) {
        console.error(
          "[SMARTBILL] HISTORY ERROR MESSAGE:",
          error.message,
        );

        console.error(
          "[SMARTBILL] HISTORY ERROR STACK:",
          error.stack,
        );
      }

      return {
        ok: false,
        error:
          "Transfer was created in Shopify, but saving Import History failed.",
        details: {
          transfer:
            createdTransfer,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      };
    }

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "[SMARTBILL] ==================================================",
    );

    console.log(
      "[SMARTBILL] TRANSFER CREATED SUCCESSFULLY",
    );

    console.log(
      "[SMARTBILL] Transfer:",
      JSON.stringify(
        createdTransfer,
        null,
        2,
      ),
    );

    console.log(
      "[SMARTBILL] Total ACTION duration:",
      Date.now() -
        startedAt,
      "ms",
    );

    console.log(
      "[SMARTBILL] ==================================================",
    );

    return {
      ok: true,

      transfer: {
        id:
          createdTransfer.id,

        name:
          createdTransfer.name,

        status:
          createdTransfer.status,

        referenceName:
          createdTransfer.referenceName,

        origin:
          createdTransfer.origin,

        destination:
          createdTransfer.destination,
      },
    };
  } catch (error) {
    console.error(
      "[SMARTBILL] ==================================================",
    );

    console.error(
      "[SMARTBILL] UNHANDLED ACTION ERROR:",
      error,
    );

    if (
      error instanceof Error
    ) {
      console.error(
        "[SMARTBILL] ERROR MESSAGE:",
        error.message,
      );

      console.error(
        "[SMARTBILL] ERROR STACK:",
        error.stack,
      );
    }

    console.error(
      "[SMARTBILL] ==================================================",
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unexpected server error.",
      details: {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
    };
  }
};

// ============================================================
// UI
// ============================================================

export default function TransferImporter() {
  const {
    importHistory,
  } = useLoaderData<
    typeof loader
  >();

  const fetcher =
    useFetcher<
      typeof action
    >();

  const isSubmitting =
    fetcher.state !== "idle";

  const result =
    fetcher.data as
      | ActionResult
      | undefined;

  return (
    <s-page heading="Transfer Importer">

      {/* ======================================================
          IMPORT
      ====================================================== */}

      <s-section heading="Import SmartBill delivery note">

        <fetcher.Form
          method="post"
          encType="multipart/form-data"
        >

          <input
            type="hidden"
            name="action"
            value="createTransfer"
          />

          <s-stack
            direction="block"
            gap="base"
          >

            <s-text>
              Upload a SmartBill delivery note PDF.
            </s-text>

            <input
              type="file"
              name="file"
              accept="application/pdf,.pdf"
              required
            />

            <s-button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting
                ? "Importing..."
                : "Import transfer"}
            </s-button>

          </s-stack>

        </fetcher.Form>

      </s-section>

      {/* ======================================================
          RESULT
      ====================================================== */}

      {result?.ok && result.transfer ? (
        <s-section heading="Import successful">

          <s-paragraph>
            Transfer{" "}
            <strong>
              {result.transfer.name}
            </strong>{" "}
            was created successfully.
          </s-paragraph>

          {result.transfer.id ? (
            <s-button
              href={getTransferAdminUrl(
                window.location.hostname,
                result.transfer.id,
              )}
              target="_blank"
            >
              View transfer
            </s-button>
          ) : null}

        </s-section>
      ) : null}

      {result &&
      !result.ok ? (
        <s-section heading="Error">

          <s-paragraph>
            {result.error}
          </s-paragraph>

          {result.details ? (
            <pre
              style={{
                whiteSpace:
                  "pre-wrap",
                overflowWrap:
                  "anywhere",
                fontSize:
                  "12px",
              }}
            >
              {JSON.stringify(
                result.details,
                null,
                2,
              )}
            </pre>
          ) : null}

        </s-section>
      ) : null}

      {/* ======================================================
          HISTORY
      ====================================================== */}

      <s-section heading="Recent imports">

        {importHistory.length === 0 ? (
          <s-paragraph>
            No transfers have been imported yet.
          </s-paragraph>
        ) : (
          <s-table>

            <s-table-header-row>

              <s-table-header>
                Delivery note number
              </s-table-header>

              <s-table-header>
                Shopify transfer
              </s-table-header>

              <s-table-header>
                Action
              </s-table-header>

            </s-table-header-row>

            <s-table-body>

              {importHistory.map(
                (item) => (
                  <s-table-row
                    key={item.id}
                  >

                    <s-table-cell>
                      {item.avizNumber}
                    </s-table-cell>

                    <s-table-cell>
                      {item.transferName}
                    </s-table-cell>

                    <s-table-cell>

                      <s-button
                        href={
                          item.transferUrl
                        }
                        target="_blank"
                      >
                        View transfer
                      </s-button>

                    </s-table-cell>

                  </s-table-row>
                ),
              )}

            </s-table-body>

          </s-table>
        )}

      </s-section>

    </s-page>
  );
}
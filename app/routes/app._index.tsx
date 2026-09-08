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
// Locația este identificată DOAR după "Adresa de livrare"
// din documentul SmartBill.
//
// Nu folosim:
// - Adresa furnizorului
// - Adresa clientului
// - alte "Adresa:" din document
//
// Există doar 2 locații:
//
// 1. Magazin Promenada
// 2. Sediu Principal
//
// După ce identificăm DESTINAȚIA din "Adresa de livrare",
// ORIGINEA este automat cealaltă locație.
// ============================================================

const LOCATION_PROMENADA = {
  id: "gid://shopify/Location/88240128340",
  name: "Magazin Promenada",

  deliveryAddressKeywords: [
    "sediul secundar promenada mall",
    "calea floreasca",
    "244-246",
  ],
};

const LOCATION_SEDIU = {
  id: "gid://shopify/Location/52695138464",
  name: "Sediu Principal",

  deliveryAddressKeywords: [
    "murmur electromagnetica",
    "calea rahovei",
    "266-288",
  ],
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

  // Adresa de livrare este SINGURA adresă folosită
  // pentru identificarea locației.
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

function normalizeAddress(value: string) {
  return value
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ============================================================
// IDENTIFY LOCATION FROM DELIVERY ADDRESS
// ============================================================
//
// IMPORTANT:
//
// Această funcție primește EXCLUSIV textul din:
//
// Adresa de livrare:
//
// Nu primește "Adresa:".
// Nu primește adresa furnizorului.
// Nu primește alte adrese din document.
//
// ============================================================

function deliveryAddressMatches(
  address: string,
  keywords: string[],
) {
  const normalized = normalizeAddress(address);

  return keywords.every((keyword) =>
    normalized.includes(
      normalizeAddress(keyword),
    ),
  );
}

function getDestinationLocation(
  deliveryAddress: string,
): TransferLocation | null {
  // ----------------------------------------------------------
  // PROMENADA
  // ----------------------------------------------------------

  if (
    deliveryAddressMatches(
      deliveryAddress,
      LOCATION_PROMENADA.deliveryAddressKeywords,
    )
  ) {
    return {
      id: LOCATION_PROMENADA.id,
      name: LOCATION_PROMENADA.name,
    };
  }

  // ----------------------------------------------------------
  // SEDIU PRINCIPAL
  // ----------------------------------------------------------

  if (
    deliveryAddressMatches(
      deliveryAddress,
      LOCATION_SEDIU.deliveryAddressKeywords,
    )
  ) {
    return {
      id: LOCATION_SEDIU.id,
      name: LOCATION_SEDIU.name,
    };
  }

  return null;
}

// ============================================================
// GET THE OTHER LOCATION
// ============================================================
//
// Avem doar 2 locații.
//
// Dacă destinația este Promenada,
// originea este Sediu Principal.
//
// Dacă destinația este Sediu Principal,
// originea este Promenada.
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

function parseAviz(text: string): ParsedAviz {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // ----------------------------------------------------------
  // DELIVERY NOTE NUMBER
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
  //
  // FOARTE IMPORTANT:
  //
  // Identificarea locației se face DOAR pe baza acestui
  // câmp.
  //
  // Exemplu Promenada:
  //
  // Adresa de livrare: SEDIUL SECUNDAR PROMENADA MALL,
  // Calea Floreasca nr 244-246, Sector 2, Bucuresti
  //
  // Exemplu Sediu Principal:
  //
  // Adresa de livrare: MURMUR ELECTROMAGNETICA, Calea
  // Rahovei 266-288, corp 3, etaj 2, Sector 5, Bucuresti
  //
  // Adresa poate ocupa mai multe linii.
  // ----------------------------------------------------------

  const deliveryAddressMatch = normalized.match(
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
  const started = performance.now();

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

  if (json.errors) {
    throw new Error(
      `Shopify SKU lookup failed for ${sku}.`,
    );
  }

  const nodes =
    json.data?.productVariants?.nodes ??
    [];

  const variant = nodes.find(
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
  const { admin, session } =
    await authenticate.admin(request);

  try {
    console.log(
      "[SMARTBILL] REQUEST START",
      new Date().toISOString(),
    );

    const formData =
      await request.formData();

    const createTransfer =
      formData.get("createTransfer") ===
      "true";

    // ========================================================
    // CREATE TRANSFER
    // ========================================================

    if (createTransfer) {
      console.log(
        "[SMARTBILL] CREATE TRANSFER START",
        new Date().toISOString(),
      );

      const transferDataRaw =
        formData.get("transferData");

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
      // DUPLICATE CHECK
      // ------------------------------------------------------

      const existingImport =
        await prisma.importHistory.findUnique({
          where: {
            shop_avizNumber: {
              shop: session.shop,
              avizNumber: aviz.number,
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

      console.log(
        "=== SMARTBILL CREATE TRANSFER ===",
      );

      console.log(
        "Delivery note:",
        aviz.number,
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
        "Destination:",
        destinationLocation.name,
      );

      console.log(
        "Products:",
        items.length,
      );

      // ------------------------------------------------------
      // IDEMPOTENCY KEY
      // ------------------------------------------------------

      const idempotencyKey =
        `smartbill-${session.shop}-${aviz.number}`;

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
            }
          }
        }
      `;

      console.log(
        "[SMARTBILL] BEFORE SHOPIFY CREATE",
        new Date().toISOString(),
      );

      const started =
        performance.now();

      const response =
        await admin.graphql(
          mutation,
          {
            variables: {
              input: {
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
              },

              idempotencyKey,
            },
          },
        );

      const json =
        (await response.json()) as any;

      console.log(
        `[SMARTBILL] inventoryTransferCreate: ${(performance.now() - started).toFixed(0)} ms`,
      );

      if (json.errors) {
        return {
          ok: false,
          error:
            "Shopify returned an error while creating the transfer.",
          details: json.errors,
        };
      }

      const result =
        json.data
          ?.inventoryTransferCreate;

      if (!result) {
        return {
          ok: false,
          error:
            "Shopify did not return a transfer creation result.",
          details: json,
        };
      }

      if (result.userErrors?.length) {
        console.error(
          "SHOPIFY TRANSFER CREATION USER ERRORS:",
          JSON.stringify(
            result.userErrors,
            null,
            2,
          ),
        );

        return {
          ok: false,
          error:
            "Shopify rejected the transfer creation.",
          details:
            result.userErrors,
        };
      }

      if (
        !result.inventoryTransfer
      ) {
        return {
          ok: false,
          error:
            "Shopify did not return the created transfer.",
          details: result,
        };
      }

      const transfer =
        result.inventoryTransfer;

      const adminUrl =
        getTransferAdminUrl(
          session.shop,
          transfer.id,
        );

      console.log(
        "Transfer created:",
        transfer.name,
      );

      // ------------------------------------------------------
      // SAVE IMPORT HISTORY
      // ------------------------------------------------------

      await prisma.importHistory.create({
        data: {
          shop: session.shop,
          avizNumber: aviz.number,
          transferId: transfer.id,
          transferName: transfer.name,
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
          id: transfer.id,
          name: transfer.name,
          status: transfer.status,
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
      "=== SMARTBILL PDF IMPORT START ===",
    );

    // --------------------------------------------------------
    // 1. EXTRACT PDF TEXT
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
        parseAviz(avizText);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not parse the delivery note.",
      };
    }

    console.log(
      "Delivery note identified:",
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
      "SKUs:",
      aviz.items,
    );

    // --------------------------------------------------------
    // 3. CHECK IF ALREADY IMPORTED
    // --------------------------------------------------------

    const existingImport =
      await prisma.importHistory.findUnique({
        where: {
          shop_avizNumber: {
            shop: session.shop,
            avizNumber: aviz.number,
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
    // 4. IDENTIFY DESTINATION
    // --------------------------------------------------------
    //
    // IMPORTANT:
    //
    // Folosim DOAR:
    //
    // aviz.deliveryAddress
    //
    // Nu folosim nicio altă adresă din PDF.
    //
    // --------------------------------------------------------

    const destinationLocation =
      getDestinationLocation(
        aviz.deliveryAddress,
      );

    if (!destinationLocation) {
      return {
        ok: false,
        error:
          "The delivery address does not match any configured Shopify location.",

        details: {
          deliveryAddress:
            aviz.deliveryAddress,

          configuredLocations: {
            promenada: {
              name:
                LOCATION_PROMENADA.name,
              deliveryAddressKeywords:
                LOCATION_PROMENADA.deliveryAddressKeywords,
            },

            sediu: {
              name:
                LOCATION_SEDIU.name,
              deliveryAddressKeywords:
                LOCATION_SEDIU.deliveryAddressKeywords,
            },
          },
        },
      };
    }

    // --------------------------------------------------------
    // 5. ORIGIN = THE OTHER LOCATION
    // --------------------------------------------------------
    //
    // Avem doar două locații.
    //
    // Dacă destinația este Promenada:
    //
    // Sediu Principal → Magazin Promenada
    //
    // Dacă destinația este Sediu Principal:
    //
    // Magazin Promenada → Sediu Principal
    // --------------------------------------------------------

    const originLocation =
      getOriginLocation(
        destinationLocation,
      );

    console.log(
      "=== TRANSFER DIRECTION ===",
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
      "Destination:",
      destinationLocation.name,
    );

    // --------------------------------------------------------
    // 6. SKU LOOKUP - IN PARALLEL
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
        "All SKUs were found in Shopify.",
      );

      console.log(
        "[SMARTBILL] BEFORE RESPONSE",
        new Date().toISOString(),
      );

      // ------------------------------------------------------
      // 7. PREVIEW
      // ------------------------------------------------------

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
      "SMARTBILL IMPORT ERROR:",
      error,
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

    // Reidentificăm destinația DOAR din deliveryAddress.
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

    // Originea este automat cealaltă locație.
    const originLocation =
      getOriginLocation(
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
    <s-page
      heading="ShopyBill"
    >
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
              {
                previewData.aviz
                  .date ||
                "Not specified"
              }
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
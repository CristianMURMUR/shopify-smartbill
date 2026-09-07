import { useEffect, useState } from "react";

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";

import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// ============================================================
// SHOPIFY LOCATIONS
// ============================================================

const LOCATION_1_ID = "gid://shopify/Location/86611853498";
const LOCATION_1_NAME = "Shop location";
const LOCATION_1_ADDRESS =
  "Calea Floreasca nr 244-246, Sector 1, Jud.: Bucuresti";

const LOCATION_3_ID = "gid://shopify/Location/86611919034";
const LOCATION_3_NAME = "My Custom Location";
const LOCATION_3_ADDRESS =
  "MURMUR ELECTROMAGNETICA, Calea Rahovei 266-288, corp 3, etaj 2, Sector 5, Bucuresti";

// ============================================================
// SHOPIFY ADMIN URL
// ============================================================

const SHOPIFY_ADMIN_TRANSFERS_PATH =
  "/admin/inventory/transfers";

function getTransferAdminUrl(
  transferId: string,
) {
  const numericId =
    transferId.split("/").pop();

  return numericId
    ? `${SHOPIFY_ADMIN_TRANSFERS_PATH}/${numericId}`
    : SHOPIFY_ADMIN_TRANSFERS_PATH;
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
  ignoredSupplierAddress: string;
  clientAddress: string;
  locationAddress: string;
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

type ImportHistoryItem = {
  id: string;
  avizNumber: string;
  transferId: string;
  transferName: string;
  createdAt: string;
};

type LoaderData = {
  importHistory: ImportHistoryItem[];
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
}: LoaderFunctionArgs): Promise<LoaderData> => {
  await authenticate.admin(request);

  // Import history will be connected to Prisma
  // after the schema is updated.
  return {
    importHistory: [],
  };
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

function getLocationByAddress(
  address: string,
): TransferLocation | null {
  const normalized = normalizeAddress(address);

  if (
    normalized ===
    normalizeAddress(LOCATION_1_ADDRESS)
  ) {
    return {
      id: LOCATION_1_ID,
      name: LOCATION_1_NAME,
    };
  }

  if (
    normalized ===
    normalizeAddress(LOCATION_3_ADDRESS)
  ) {
    return {
      id: LOCATION_3_ID,
      name: LOCATION_3_NAME,
    };
  }

  return null;
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

  const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

  // ----------------------------------------------------------
  // FIRST ADDRESS = IGNORE
  // ----------------------------------------------------------

  const supplierAddressMatch = normalized.match(
    /Furnizor\s+Client[\s\S]*?Adresa:\s*([^\n]+)/i,
  );

  const ignoredSupplierAddress =
    supplierAddressMatch?.[1]?.trim() ?? "";

  // ----------------------------------------------------------
  // DELIVERY ADDRESS = CLIENT
  // ----------------------------------------------------------

  const deliveryAddressMatch = normalized.match(
    /Adresa\s+de\s+livrare:\s*([\s\S]*?)(?=\nIBAN|\nBanca:|\nAdresa:|\nCIF:|\nReg\. com\.|\nNr\.\s*crt)/i,
  );

  if (!deliveryAddressMatch) {
    throw new Error(
      "Could not identify the delivery address.",
    );
  }

  const clientAddress =
    deliveryAddressMatch[1]
      .replace(/\s+/g, " ")
      .trim();

  // ----------------------------------------------------------
  // LAST SIMPLE "Adresa:"
  // ----------------------------------------------------------

  const plainAddressMatches = [
    ...normalized.matchAll(
      /(?:^|\n)Adresa:\s*([^\n]+)/gi,
    ),
  ];

  if (plainAddressMatches.length === 0) {
    throw new Error(
      "Could not identify the warehouse location address.",
    );
  }

  const lastAddressMatch =
    plainAddressMatches[
      plainAddressMatches.length - 1
    ];

  const locationAddress =
    lastAddressMatch[1]
      .replace(/\s+/g, " ")
      .trim();

  // ----------------------------------------------------------
  // SKU + QUANTITY
  // ----------------------------------------------------------

  const skuMatches = [
    ...normalized.matchAll(
      /\(([A-Z0-9][A-Z0-9-]{5,})\)/gi,
    ),
  ];

  const items: AvizItem[] = [];

  for (let i = 0; i < skuMatches.length; i++) {
    const sku =
      skuMatches[i][1].toUpperCase();

    const start =
      skuMatches[i].index ?? 0;

    const end =
      i + 1 < skuMatches.length
        ? skuMatches[i + 1].index ??
          normalized.length
        : normalized.length;

    const block = normalized.slice(
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
    ignoredSupplierAddress,
    clientAddress,
    locationAddress,
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
  const { admin } =
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
        "[SMARTBILL] CREATE BRANCH START",
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

      console.log(
        "=== SMARTBILL CREATE TRANSFER ===",
      );

      console.log(
        "Delivery note:",
        aviz.number,
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
        `smartbill-${aviz.number}`;

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

      if (
        result.userErrors?.length
      ) {
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

      console.log(
        "Transfer created:",
        transfer.name,
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
      "Ignored supplier address:",
      aviz.ignoredSupplierAddress,
    );

    console.log(
      "Client address:",
      aviz.clientAddress,
    );

    console.log(
      "Location address:",
      aviz.locationAddress,
    );

    console.log(
      "SKUs:",
      aviz.items,
    );

    // --------------------------------------------------------
    // 3. LOCATIONS
    // --------------------------------------------------------

    const originLocation =
      getLocationByAddress(
        aviz.locationAddress,
      );

    const destinationLocation =
      getLocationByAddress(
        aviz.clientAddress,
      );

    if (
      !originLocation ||
      !destinationLocation
    ) {
      return {
        ok: false,
        error:
          "The addresses in the delivery note do not match the configured Shopify locations.",
        details: {
          ignoredSupplierAddress:
            aviz.ignoredSupplierAddress,

          locationAddress:
            aviz.locationAddress,

          clientAddress:
            aviz.clientAddress,

          location1:
            LOCATION_1_ADDRESS,

          location3:
            LOCATION_3_ADDRESS,
        },
      };
    }

    if (
      originLocation.id ===
      destinationLocation.id
    ) {
      return {
        ok: false,
        error:
          "The origin and destination locations are the same.",
      };
    }

    // --------------------------------------------------------
    // 4. SKU LOOKUP - IN PARALLEL
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
      // 5. PREVIEW
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
  const { importHistory } =
    useLoaderData<
      typeof loader
    >();

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

  // ==========================================================
  // TOASTS
  // ==========================================================

  useEffect(() => {
    if (
      fetcher.data?.ok &&
      fetcher.data.mode ===
        "transfer"
    ) {
      shopify.toast.show(
        `Transfer created for ${
          fetcher.data.transfer
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

    const originLocation =
      getLocationByAddress(
        previewData.aviz
          .locationAddress,
      );

    const destinationLocation =
      getLocationByAddress(
        previewData.aviz
          .clientAddress,
      );

    if (
      !originLocation ||
      !destinationLocation
    ) {
      shopify.toast.show(
        "The transfer locations could not be identified.",
      );

      return;
    }

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
      heading="SmartBill Transfer Importer"
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
                Delivery Note:
              </strong>{" "}
              {
                previewData.aviz
                  .number
              }
            </s-paragraph>

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

      {fetcher.data?.ok &&
      fetcher.data.mode ===
        "transfer" ? (
        <s-section
          heading="Transfer Created"
        >
          <s-stack
            direction="block"
            gap="base"
          >
            <s-heading>
              {
                fetcher.data
                  .transfer
                  .referenceName ??
                fetcher.data
                  .transfer
                  .name
              }
            </s-heading>

            <s-paragraph>
              <strong>
                Shopify Transfer:
              </strong>{" "}
              {
                fetcher.data
                  .transfer
                  .name
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Status:
              </strong>{" "}
              {
                fetcher.data
                  .transfer
                  .status
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Direction:
              </strong>{" "}
              {
                fetcher.data
                  .transfer
                  .origin
              }
              {" → "}
              {
                fetcher.data
                  .transfer
                  .destination
              }
            </s-paragraph>

            <s-button
              onClick={() => {
                if (
                  fetcher.data?.ok &&
                  fetcher.data.mode === "transfer"
                ) {
                  window.open(
                    getTransferAdminUrl(
                      fetcher.data.transfer.id,
                    ),
                    "_blank",
                  );
                }
              }}
            >
              View transfer
            </s-button>

            <s-divider />

            <s-heading>
              Transferred Products
            </s-heading>

            {fetcher.data.items.map(
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

      {/* ====================================================
          IMPORT HISTORY
      ==================================================== */}

      <s-section
        heading="Import History"
      >
        <s-stack
          direction="block"
          gap="base"
        >
          <s-stack
            direction="inline"
            gap="base"
          >
            <s-button
              onClick={() => {
                window.open(
                  SHOPIFY_ADMIN_TRANSFERS_PATH,
                  "_blank",
                );
              }}
            >
              View all transfers
            </s-button>
          </s-stack>

          {importHistory.length ===
          0 ? (
            <s-paragraph>
              No imports yet.
            </s-paragraph>
          ) : (
            importHistory.map(
              (item) => (
                <s-box
                  key={item.id}
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
                        {item.avizNumber}
                      </strong>
                    </span>

                    <span>
                      →
                    </span>

                    <span>
                      <strong>
                        {item.transferName}
                      </strong>
                    </span>

                    <s-button
                      onClick={() => {
                        window.open(
                          getTransferAdminUrl(
                            item.transferId,
                          ),
                          "_blank",
                        );
                      }}
                    >
                      View transfer
                    </s-button>
                  </s-stack>
                </s-box>
              ),
            )
          )}
        </s-stack>
      </s-section>
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
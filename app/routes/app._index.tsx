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

// ============================================================
// SHOPIFY LOCATIONS
// ============================================================

const LOCATION_1_ID =
  "gid://shopify/Location/86611853498";

const LOCATION_1_NAME =
  "Shop location";

const LOCATION_1_ADDRESS =
  "Calea Floreasca nr 244-246, Sector 1, Jud.: Bucuresti";

const LOCATION_3_ID =
  "gid://shopify/Location/86611919034";

const LOCATION_3_NAME =
  "My Custom Location";

const LOCATION_3_ADDRESS =
  "MURMUR ELECTROMAGNETICA, Calea Rahovei 266-288, corp 3, etaj 2, Sector 5, Bucuresti";

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
}: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
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

function parseAviz(
  text: string,
): ParsedAviz {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // ----------------------------------------------------------
  // AVIZ NUMBER
  // ----------------------------------------------------------

  const numberMatch =
    normalized.match(
      /\b(AVIZ[A-Z0-9-]+)\b/i,
    );

  if (!numberMatch) {
    throw new Error(
      "Nu am putut identifica numarul avizului.",
    );
  }

  // ----------------------------------------------------------
  // DATE
  // ----------------------------------------------------------

  const dateMatch =
    normalized.match(
      /Data\s+emiterii\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i,
    );

  if (!dateMatch) {
    throw new Error(
      "Nu am putut identifica data avizului.",
    );
  }

  const date =
    `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

  // ----------------------------------------------------------
  // FIRST ADDRESS = IGNORE
  //
  // This is the Miraslau address.
  // It is intentionally NOT used for the transfer.
  // ----------------------------------------------------------

  const supplierAddressMatch =
    normalized.match(
      /Furnizor\s+Client[\s\S]*?Adresa:\s*([^\n]+)/i,
    );

  const ignoredSupplierAddress =
    supplierAddressMatch?.[1]?.trim() ?? "";

  // ----------------------------------------------------------
  // DELIVERY ADDRESS = CLIENT
  // ----------------------------------------------------------

  const deliveryAddressMatch =
    normalized.match(
      /Adresa\s+de\s+livrare:\s*([\s\S]*?)(?=\nIBAN|\nBanca:|\nAdresa:|\nCIF:|\nReg\. com\.|\nNr\.\s*crt)/i,
    );

  if (!deliveryAddressMatch) {
    throw new Error(
      "Nu am putut identifica adresa de livrare.",
    );
  }

  const clientAddress =
    deliveryAddressMatch[1]
      .replace(/\s+/g, " ")
      .trim();

  // ----------------------------------------------------------
  // LAST SIMPLE "Adresa:"
  //
  // This is the Floreasca address.
  // The first simple address (Miraslau) is ignored.
  // ----------------------------------------------------------

  const plainAddressMatches = [
    ...normalized.matchAll(
      /(?:^|\n)Adresa:\s*([^\n]+)/gi,
    ),
  ];

  if (
    plainAddressMatches.length === 0
  ) {
    throw new Error(
      "Nu am putut identifica adresa locatiei.",
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
      normalized.slice(start, end);

    const quantityMatch =
      block.match(
        /\bbuc\s+(\d+(?:[.,]\d+)?)\b/i,
      );

    if (!quantityMatch) {
      throw new Error(
        `Nu am putut identifica cantitatea pentru SKU ${sku}.`,
      );
    }

    const quantity =
      Number(
        quantityMatch[1].replace(
          ",",
          ".",
        ),
      );

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        `Cantitate invalida pentru SKU ${sku}.`,
      );
    }

    items.push({
      sku,
      quantity,
    });
  }

  if (items.length === 0) {
    throw new Error(
      "Nu am identificat niciun SKU in PDF.",
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

  console.log("[SMARTBILL] BEFORE CREATE", new Date().toISOString());

  const started =
    performance.now();

  const arrayBuffer =
    await file.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  console.log(
    `[SMARTBILL] PDF primit: ${file.name} (${buffer.length} bytes)`,
  );

  const { PDFParse } =
    await import("pdf-parse");

  const parser =
    new PDFParse({
      data: buffer,
    });

  try {
    const result =
      await parser.getText();

    console.log(
      `[SMARTBILL] PDF parse: ${(performance.now() - started).toFixed(0)} ms`,
    );

    console.log(
      `[SMARTBILL] Text extras: ${result.text.length} caractere`,
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
      `Eroare la cautarea SKU ${sku}.`,
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
      `SKU-ul ${sku} nu a fost gasit in Shopify.`,
    );
  }

  if (!variant.inventoryItem?.id) {
    throw new Error(
      `SKU-ul ${sku} nu are Inventory Item in Shopify.`,
    );
  }

  return {
    sku,
    quantity: 0,
    productTitle:
      variant.product?.title ??
      "",
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
    console.log("[SMARTBILL] REQUEST START", new Date().toISOString());

    const formData =
      await request.formData();

    const createTransfer =
      formData.get(
        "createTransfer",
      ) === "true";





    // ========================================================
    // CREATE TRANSFER
    //
    // IMPORTANT:
    // We DO NOT read the PDF here.
    // We DO NOT parse it again.
    // We DO NOT query the SKUs again.
    // We DO NOT query locations again.
    //
    // We use the already validated preview data.
    // ========================================================

    if (createTransfer) {
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
            "Datele preview-ului lipsesc. Proceseaza din nou PDF-ul.",
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
            "Datele transferului sunt invalide.",
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
            "Date incomplete pentru crearea transferului.",
        };
      }

      console.log(
        "=== SMARTBILL CREATE TRANSFER ===",
      );

      console.log(
        "Aviz:",
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
        "Produse:",
        items.length,
      );
      

      // ------------------------------------------------------
      // IDEMPOTENCY KEY
      //
      // Same aviz = same operation.
      // This prevents duplicate creation on retry.
      // ------------------------------------------------------

      const idempotencyKey =
        `smartbill-${aviz.number}`;

      const mutation = `
        #graphql
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
                  `Import SmartBill ${aviz.number}`,

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
            "Eroare Shopify la crearea transferului.",
          details:
            json.errors,
        };
      }

      const result =
        json.data
          ?.inventoryTransferCreate;

      if (!result) {
        return {
          ok: false,
          error:
            "Shopify nu a returnat rezultatul crearii transferului.",
          details:
            json,
        };
      }

      if (
        result.userErrors?.length
      ) {
        return {
          ok: false,
          error:
            "Shopify a respins crearea transferului.",
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
            "Shopify nu a returnat transferul creat.",
          details:
            result,
        };
      }

      const transfer =
        result.inventoryTransfer;

      console.log(
        "Transfer creat:",
        transfer.name,
      );

      console.log("[SMARTBILL] BEFORE RESPONSE", new Date().toISOString());

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
        },

        items:
          items.map(
            (item) => ({
              sku:
                item.sku,

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
          "Nu ai selectat niciun PDF.",
      };
    }

    if (file.size === 0) {
      return {
        ok: false,
        error:
          "PDF-ul este gol.",
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
          "Fisierul trebuie sa fie PDF.",
      };
    }

    console.log(
      "=== SMARTBILL PDF IMPORT START ===",
    );

    // --------------------------------------------------------
    // 1. PDF
    // --------------------------------------------------------

    const avizText =
      await extractPdfText(file);

    if (!avizText.trim()) {
      return {
        ok: false,
        error:
          "PDF-ul nu contine text care poate fi extras.",
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
            : "Nu am putut interpreta avizul.",
      };
    }

    console.log(
      "Aviz identificat:",
      aviz.number,
    );

    console.log(
      "Adresa furnizorului IGNORATA:",
      aviz.ignoredSupplierAddress,
    );

    console.log(
      "Adresa clientului:",
      aviz.clientAddress,
    );

    console.log(
      "Adresa locatiei:",
      aviz.locationAddress,
    );

    console.log(
      "SKU-uri:",
      aviz.items,
    );

    // --------------------------------------------------------
    // 3. LOCATII
    //
    // NO SHOPIFY REQUEST HERE.
    //
    // We already know the configured addresses and IDs.
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
          "Adresele avizului nu corespund locatiilor configurate.",

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
          "Locatia de origine si locatia de destinatie sunt aceeasi.",
      };
    }

    // --------------------------------------------------------
    // 4. SKU LOOKUP - IN PARALEL
    //
    // Previously:
    //
    // SKU 1 -> wait
    // SKU 2 -> wait
    // SKU 3 -> wait
    //
    // Now:
    //
    // SKU 1 ─┐
    // SKU 2 ─┼-> parallel
    // SKU 3 ─┘
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
        "Toate SKU-urile au fost gasite in Shopify.",
      );

      console.log("[SMARTBILL] BEFORE RESPONSE", new Date().toISOString());


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

        items:
          foundItems,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Eroare la cautarea produselor in Shopify.",
      };
    }
  } catch (error) {
    console.error(
      "EROARE IMPORT SMARTBILL:",
      error,
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "A aparut o eroare la procesarea PDF-ului.",
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
    fetcher.formMethod ===
      "POST";

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
        "Transferul Shopify a fost creat.",
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
  //
  // IMPORTANT:
  // We send the preview data.
  // We DO NOT send the PDF again.
  // ==========================================================

  const createTransfer =
    () => {
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
          "Locatiile transferului nu mai pot fi identificate.",
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
      <s-section
        heading="Importa aviz SmartBill"
      >
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Upload smartbill delivery note (PDF)
          </s-paragraph>

          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const selectedFile =
                event.target
                  .files?.[0] ??
                null;

              setFile(
                selectedFile,
              );

              if (
                selectedFile
              ) {
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
                <s-text>
                  Fisier selectat:
                </s-text>

                <s-text>
                  {file.name}
                </s-text>

                <s-text>
                  {(
                    file.size /
                    1024
                  ).toFixed(
                    1,
                  )}{" "}
                  KB
                </s-text>

                {isLoading ? (
                  <s-text>
                    Se proceseaza PDF-ul...
                  </s-text>
                ) : null}
              </s-stack>
            </s-box>
          ) : null}
        </s-stack>
      </s-section>

      {/* =====================================================
          PREVIEW
      ===================================================== */}

      {previewData ? (
        <s-section
          heading={`Aviz ${previewData.aviz.number}`}
        >
          <s-stack
            direction="block"
            gap="base"
          >
            <s-paragraph>
              <strong>
                Delivery note:
              </strong>{" "}
              {
                previewData
                  .aviz
                  .number
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Data:
              </strong>{" "}
              {
                previewData
                  .aviz
                  .date ||
                "nespecificata"
              }
            </s-paragraph>

            <s-paragraph>
              <strong>
                Direction:
              </strong>{" "}
              {
                previewData
                  .direction
                  .origin
              }
              {" → "}
              {
                previewData
                  .direction
                  .destination
              }
            </s-paragraph>

            <s-divider />

            <s-heading>
              Produse gasite
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
                    <s-text>
                      <strong>
                        {item.sku}
                      </strong>
                    </s-text>

                    <s-text>
                      Produs:{" "}
                      {
                        item.productTitle
                      }
                    </s-text>

                    <s-text>
                      Varianta:{" "}
                      {
                        item.variantTitle
                      }
                    </s-text>

                    <s-text>
                      Cantitate:{" "}
                      {
                        item.quantity
                      }
                    </s-text>
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
                      loading:
                        true,
                    }
                  : {}
              )}
            >
              {isLoading
                ? "Se creeaza..."
                : "Creeaza transferul"}
            </s-button>
          </s-stack>
        </s-section>
      ) : null}

      {/* =====================================================
          ERROR
      ===================================================== */}

      {fetcher.data &&
      !fetcher.data.ok ? (
        <s-section
          heading="Eroare"
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

      {/* =====================================================
          TRANSFER CREATED
      ===================================================== */}

      {fetcher.data?.ok &&
      fetcher.data.mode ===
        "transfer" ? (
        <s-section
          heading="Transfer creat"
        >
          <s-stack
            direction="block"
            gap="base"
          >
            <s-heading>
              {
                fetcher.data
                  .transfer
                  .name
              }
            </s-heading>

            <s-paragraph>
              Status:{" "}
              {
                fetcher.data
                  .transfer
                  .status
              }
            </s-paragraph>

            <s-paragraph>
              Reference:{" "}
              {
                fetcher.data
                  .transfer
                  .referenceName
              }
            </s-paragraph>

            <s-paragraph>
              Direction:{" "}
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

            <s-divider />

            <s-heading>
              Produse transferate
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
                    <s-text>
                      {item.sku}
                    </s-text>

                    <s-text>
                      Cantitate:{" "}
                      {
                        item.quantity
                      }
                    </s-text>
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
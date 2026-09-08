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
// SHOPIFY ADMIN URL
// ============================================================

function getTransferAdminUrl(
  transferId: string,
) {
  const numericId =
    transferId.split("/").pop();

  return numericId
    ? `https://admin.shopify.com/store/murmur-ro/transfers/${numericId}`
    : "https://admin.shopify.com/store/murmur-ro/transfers";
}

// ============================================================
// LOADER
// ============================================================

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const { session } =
    await authenticate.admin(request);

  const importHistory =
    await prisma.importHistory.findMany({
      where: {
        shop: session.shop,
      },

      orderBy: {
        createdAt: "desc",
      },
    });

  return {
    importHistory:
      importHistory.map((item) => ({
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
            item.transferId,
          ),
      })),
  };
};

// ============================================================
// ACTION - DELETE HISTORY ENTRY
// ============================================================

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const { session } =
    await authenticate.admin(request);

  const formData =
    await request.formData();

  const actionType =
    formData.get("action");

  // ----------------------------------------------------------
  // DELETE
  // ----------------------------------------------------------

  if (actionType === "delete") {
    const id =
      formData.get("id");

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

    // --------------------------------------------------------
    // IMPORTANT:
    // Verificăm că înregistrarea aparține shop-ului curent.
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // DELETE ONLY FROM IMPORT HISTORY
    // --------------------------------------------------------
    //
    // Transferul real din Shopify NU este șters.
    //
    // Se șterge doar înregistrarea din Transfer History.
    //
    // --------------------------------------------------------

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

  return {
    ok: false,
    error:
      "Unknown action.",
  };
};

// ============================================================
// UI
// ============================================================

export default function TransferHistory() {
  const { importHistory } =
    useLoaderData<typeof loader>();

  const fetcher =
    useFetcher<typeof action>();

  const isDeleting =
    fetcher.state !== "idle";

  return (
    <s-page heading="Transfer History">

      {/* ======================================================
          VIEW ALL SHOPIFY TRANSFERS
      ====================================================== */}

      <s-section>
        <s-button
          href="https://admin.shopify.com/store/murmur-ro/transfers"
          target="_blank"
        >
          View all transfers
        </s-button>
      </s-section>

      {/* ======================================================
          IMPORTED TRANSFERS
      ====================================================== */}

      <s-section heading="Imported transfers">

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

                    {/* --------------------------------------
                        AVIZ
                    -------------------------------------- */}

                    <s-table-cell>
                      {item.avizNumber}
                    </s-table-cell>

                    {/* --------------------------------------
                        SHOPIFY TRANSFER
                    -------------------------------------- */}

                    <s-table-cell>
                      {item.transferName}
                    </s-table-cell>

                    {/* --------------------------------------
                        ACTIONS
                    -------------------------------------- */}

                    <s-table-cell>

                      <s-stack
                        direction="inline"
                        gap="small"
                      >

                        {/* VIEW TRANSFER */}

                        <s-button
                          href={
                            item.transferUrl
                          }
                          target="_blank"
                        >
                          View transfer
                        </s-button>

                        {/* DELETE HISTORY */}

                        <s-button
                          tone="critical"
                          disabled={
                            isDeleting
                          }
                          onClick={() => {
                            const confirmed =
                              window.confirm(
                                `Are you sure you want to remove ${item.avizNumber} from Transfer History? The Shopify transfer itself will NOT be deleted.`,
                              );

                            if (
                              !confirmed
                            ) {
                              return;
                            }

                            const formData =
                              new FormData();

                            formData.append(
                              "action",
                              "delete",
                            );

                            formData.append(
                              "id",
                              item.id,
                            );

                            fetcher.submit(
                              formData,
                              {
                                method:
                                  "POST",
                              },
                            );
                          }}
                        >
                          Delete
                        </s-button>

                      </s-stack>

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
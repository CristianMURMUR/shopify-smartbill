import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function getTransferAdminUrl(transferId: string) {
  const numericId = transferId.split("/").pop();

  return numericId
    ? `https://admin.shopify.com/store/murmur-developer-test/transfers/${numericId}`
    : "https://admin.shopify.com/store/murmur-developer-test/transfers";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const importHistory = await prisma.importHistory.findMany({
    where: {
      shop: session.shop,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return {
    importHistory: importHistory.map((item) => ({
      id: item.id,
      avizNumber: item.avizNumber,
      transferId: item.transferId,
      transferName: item.transferName,
      createdAt: item.createdAt.toISOString(),
      transferUrl: getTransferAdminUrl(item.transferId),
    })),
  };
};

export default function TransferHistory() {
  const { importHistory } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Transfer History">
      <s-section>
        <s-button
          href="https://admin.shopify.com/store/murmur-developer-test/transfers"
          target="_blank"
        >
          View all transfers
        </s-button>
      </s-section>

      <s-section heading="Imported transfers">
        {importHistory.length === 0 ? (
          <s-paragraph>
            No transfers have been imported yet.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Aviz number</s-table-header>
              <s-table-header>Shopify transfer</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>

            <s-table-body>
              {importHistory.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>{item.avizNumber}</s-table-cell>

                  <s-table-cell>{item.transferName}</s-table-cell>

                  <s-table-cell>
                    <s-button
                      href={item.transferUrl}
                      target="_blank"
                    >
                      View transfer
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
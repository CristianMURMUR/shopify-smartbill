import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PROMENADA_LOCATION_ID =
  "gid://shopify/Location/88240128340";

const ORDER_QUERY = `#graphql
  query OrderForSmartBill($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      sourceName

      location {
        id
        name
      }

      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }

      lineItems(first: 250) {
        nodes {
          sku
          name
          quantity

          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          discountedUnitPriceAfterAllDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          taxable

          taxLines {
            title
            rate
          }
        }
      }

      transactions {
        gateway
        status
        kind
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
    const { topic, shop, payload, admin, webhookId } =
    await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Ignored", { status: 200 });
  }

  if (!admin) {
    console.error("orders/create webhook has no admin client");
    return new Response("OK", { status: 200 });
  }

  try {
    const orderId =
      payload?.admin_graphql_api_id ??
      (payload?.id
        ? `gid://shopify/Order/${payload.id}`
        : null);

    if (!orderId) {
      console.error("orders/create: missing order ID");
      return new Response("OK", { status: 200 });
    }

    const response = await admin.graphql(ORDER_QUERY, {
      variables: {
        id: orderId,
      },
    });

    const responseJson = await response.json();

if (
  responseJson &&
  typeof responseJson === "object" &&
  "errors" in responseJson
) {
  console.error(
    "Shopify GraphQL errors:",
    responseJson.errors,
  );

  return new Response("OK", { status: 200 });
}

    const order = responseJson.data?.order;

    if (!order) {
      console.error(
        "Shopify order not found:",
        orderId,
      );

      return new Response("OK", { status: 200 });
    }

    // Only Shopify POS orders.
    if (order.sourceName !== "pos") {
      console.log(
        `Ignoring non-POS order ${order.name}. sourceName=${order.sourceName}`,
      );

      return new Response("OK", { status: 200 });
    }

    // POS must be at Promenada.
    if (order.location?.id !== PROMENADA_LOCATION_ID) {
      console.log(
        `Ignoring POS order ${order.name}. location=${order.location?.name ?? "unknown"}`,
      );

      return new Response("OK", { status: 200 });
    }

    // Idempotency: don't save the same Shopify order twice.
    const existingBill = await prisma.shopyBill.findUnique({
      where: {
        shop_shopifyOrderId: {
          shop,
          shopifyOrderId: order.id,
        },
      },
    });

    if (existingBill) {
      console.log(
        `Shopify order ${order.name} already exists as bill ${existingBill.id}`,
      );

      return new Response("OK", { status: 200 });
    }

    const total = Number(
      order.totalPriceSet.shopMoney.amount,
    );

    const currency =
      order.totalPriceSet.shopMoney.currencyCode;

    const items = order.lineItems.nodes.map(
      (item: any) => {
        const discountedPrice =
          item.discountedUnitPriceAfterAllDiscountsSet
            ?.shopMoney?.amount;

        const originalPrice =
          item.originalUnitPriceSet?.shopMoney?.amount;

        const unitPrice =
          discountedPrice != null
            ? Number(discountedPrice)
            : Number(originalPrice ?? 0);

        const taxLine =
          item.taxLines?.length > 0
            ? item.taxLines[0]
            : null;

        return {
          sku: item.sku ?? "",
          productName: item.name,
          quantity: Number(item.quantity),
          shopifyUnitPrice: unitPrice,
          currency,
          taxRate:
            taxLine?.rate != null
              ? Number(taxLine.rate)
              : null,
          taxName: taxLine?.title ?? null,
          taxable: Boolean(item.taxable),
        };
      },
    );

    const bill = await prisma.shopyBill.create({
      data: {
        shop,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        shopifyLocationId:
          order.location?.id ?? null,
        shopifyLocationName:
          order.location?.name ?? null,
        sourceName: order.sourceName ?? null,
        total,
        currency,
        status: "RECEIVED",
        webhookId: webhookId ?? null,

        items: {
          create: items,
        },
      },

      include: {
        items: true,
      },
    });

    console.log(
      `Shopify POS order ${order.name} saved as RECEIVED. Bill ID=${bill.id}`,
    );

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(
      "orders/create webhook processing error:",
      error,
    );

    // We intentionally acknowledge the webhook.
    // The order has its own FAILED/RETRY flow later.
    return new Response("OK", { status: 200 });
  }
};
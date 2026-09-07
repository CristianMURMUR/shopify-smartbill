import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SmartBill → Shopify</h1>

        <p className={styles.text}>
          Importă rapid avizele SmartBill în Shopify și creează automat
          transferurile de inventar.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>

              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop.myshopify.com"
              />

              <span>Exemplu: my-shop.myshopify.com</span>
            </label>

            <button className={styles.button} type="submit">
              Log in to Shopify
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Import rapid</strong> – încarcă un aviz SmartBill și
            extrage automat produsele și cantitățile.
          </li>

          <li>
            <strong>Transfer automat</strong> – creează transferul de
            inventar direct în Shopify.
          </li>

          <li>
            <strong>Istoric complet</strong> – păstrează evidența avizelor
            importate și a transferurilor create.
          </li>
        </ul>
      </div>
    </div>
  );
}
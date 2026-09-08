
// ======================================================
// SMARTBILL - TEST API /stocks
// ======================================================
//
// IMPORTANT:
// - Fișierul este .mjs => JavaScript, NU TypeScript
// - NU folosim sessionid
// - NU folosim csrftoken
// - NU folosim cookies
// - NU emitem bon
// - Doar testăm forma REALĂ a răspunsului /stocks
//
// ======================================================


// ======================================================
// 1. CONFIGURARE
// ======================================================

import "dotenv/config";

const username = process.env.SMARTBILL_USERNAME;
const token = process.env.SMARTBILL_TOKEN;
const companyVatCode = process.env.SMARTBILL_CIF;

if (!username || !token || !companyVatCode) {
  throw new Error(
    "Lipsesc SMARTBILL_USERNAME, SMARTBILL_TOKEN sau SMARTBILL_CIF.",
  );
}


// ======================================================
// DATE TEST
// ======================================================

const SKU = "ML000HLDCOL010OS";

const WAREHOUSE_NAME = "PROMENADA";

// Format API SmartBill: YYYY-MM-DD
const LOOKUP_DATE = "2026-09-07";


// ======================================================
// 2. SMARTBILL AUTH
// ======================================================

const basicAuth = Buffer.from(
  `${username}:${token}`
).toString("base64");


// ======================================================
// 3. API URL
// ======================================================

const SMARTBILL_API =
  "https://ws.smartbill.ro/SBORO/api";


// ======================================================
// 4. CONSTRUIM REQUEST-UL /stocks
// ======================================================

const params = new URLSearchParams();

params.set(
  "cif",
  companyVatCode
);

params.set(
  "date",
  LOOKUP_DATE
);

params.set(
  "warehouseName",
  WAREHOUSE_NAME
);

params.set(
  "productCode",
  SKU
);

const lookupUrl =
  `${SMARTBILL_API}/stocks?${params.toString()}`;


// ======================================================
// 5. AFIȘĂM REQUEST-UL
// ======================================================

console.log("\n================================");
console.log("SMARTBILL /STOCKS TEST");
console.log("================================");

console.log("SKU:", SKU);
console.log("Gestiune:", WAREHOUSE_NAME);
console.log("Data:", LOOKUP_DATE);

console.log("\nREQUEST URL:");
console.log(lookupUrl);


// ======================================================
// 6. REQUEST
// ======================================================

const response = await fetch(
  lookupUrl,
  {
    method: "GET",

    headers: {
      Accept: "application/json",

      Authorization:
        `Basic ${basicAuth}`,
    },
  }
);


// ======================================================
// 7. CITIM RĂSPUNSUL RAW
// ======================================================

const responseText =
  await response.text();

console.log("\n================================");
console.log("SMARTBILL RESPONSE");
console.log("================================");

console.log(
  "HTTP STATUS:",
  response.status
);

console.log(
  "CONTENT-TYPE:",
  response.headers.get(
    "content-type"
  )
);

console.log("\nRAW RESPONSE:");

console.log(
  responseText
);


// ======================================================
// 8. VALIDĂM HTTP
// ======================================================

if (!response.ok) {
  throw new Error(
    `SmartBill API HTTP ${response.status}:\n\n` +
      responseText.slice(0, 10000)
  );
}


// ======================================================
// 9. PARSĂM JSON
// ======================================================

let data;

try {
  data =
    JSON.parse(responseText);
} catch {
  throw new Error(
    "SmartBill nu a returnat JSON valid."
  );
}


// ======================================================
// 10. AFIȘĂM JSON FORMATAT
// ======================================================

console.log("\n================================");
console.log("SMARTBILL JSON FORMATAT");
console.log("================================");

console.log(
  JSON.stringify(
    data,
    null,
    2
  )
);


// ======================================================
// 11. INSPECȚIE STRUCTURĂ
// ======================================================

console.log("\n================================");
console.log("STRUCTURA RĂSPUNSULUI");
console.log("================================");

console.log(
  "Este array:",
  Array.isArray(data)
);

console.log(
  "Tip root:",
  typeof data
);

if (
  data &&
  typeof data === "object" &&
  !Array.isArray(data)
) {
  console.log(
    "\nROOT KEYS:"
  );

  console.log(
    Object.keys(data)
  );
}


// ======================================================
// 12. INSPECȚIE STOCKS
// ======================================================

if (
  data &&
  typeof data === "object" &&
  !Array.isArray(data)
) {
  if (
    Object.prototype.hasOwnProperty.call(
      data,
      "stocks"
    )
  ) {
    console.log(
      "\nDATA.STOCKS:"
    );

    console.log(
      JSON.stringify(
        data.stocks,
        null,
        2
      )
    );

    console.log(
      "\nDATA.STOCKS ESTE ARRAY:",
      Array.isArray(
        data.stocks
      )
    );
  }
}


// ======================================================
// 13. INSPECȚIE PRODUCTS
// ======================================================

if (
  data &&
  typeof data === "object" &&
  !Array.isArray(data)
) {
  if (
    Object.prototype.hasOwnProperty.call(
      data,
      "products"
    )
  ) {
    console.log(
      "\nDATA.PRODUCTS:"
    );

    console.log(
      JSON.stringify(
        data.products,
        null,
        2
      )
    );

    console.log(
      "\nDATA.PRODUCTS ESTE ARRAY:",
      Array.isArray(
        data.products
      )
    );
  }
}


// ======================================================
// 14. FINAL
// ======================================================

console.log("\n================================");
console.log("TEST TERMINAT");
console.log("================================");

console.log(
  "Nu s-a emis niciun bon."
);
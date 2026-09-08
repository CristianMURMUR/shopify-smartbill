const username = process.env.SMARTBILL_USERNAME;
const token = process.env.SMARTBILL_TOKEN;
const companyVatCode = process.env.SMARTBILL_CIF;

const SKU = "ML000HLDCOL010OS";
const QUANTITY = 1;

const WAREHOUSE_ID = 136220;
const WAREHOUSE_NAME = "PROMENADA";
const ECR_ID = "39119";

// Data pentru endpointul intern SmartBill Cloud: DD-MM-YYYY
const LOOKUP_DATE = "07-09-2026";

// Data pentru API-ul public /payment: YYYY-MM-DD
const ISSUE_DATE = "2026-09-07";

// ======================================================
// 1. VALIDARE CREDENTIALS
// ======================================================

if (!username || !token || !companyVatCode) {
  throw new Error(
    "Lipsesc SMARTBILL_USERNAME, SMARTBILL_TOKEN sau SMARTBILL_CIF."
  );
}

const sessionid = process.env.SMARTBILL_SESSIONID;
const csrftoken = process.env.SMARTBILL_CSRFTOKEN;

if (!sessionid || !csrftoken) {
  throw new Error(
    "Lipsesc SMARTBILL_SESSIONID sau SMARTBILL_CSRFTOKEN."
  );
}

// ======================================================
// 2. LOOKUP PRODUS DUPA SKU
// ======================================================

console.log("\n================================");
console.log("SMARTBILL PRODUCT LOOKUP");
console.log("================================");

const lookupResponse = await fetch(
  "https://cloud.smartbill.ro/gestiune/get_stock_product_scanner_info/",
  {
    method: "POST",

    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",

      "Content-Type":
        "application/x-www-form-urlencoded; charset=UTF-8",

      Cookie:
        `sessionid=${sessionid}; csrftoken=${csrftoken}`,

      "X-CSRFToken": csrftoken,

      "X-Requested-With": "XMLHttpRequest",

      Origin: "https://cloud.smartbill.ro",

      Referer: "https://cloud.smartbill.ro/",
    },

    body: new URLSearchParams({
      warehouse_id: String(WAREHOUSE_ID),

      code: SKU,

      // IMPORTANT:
      // SmartBill Cloud folosește DD-MM-YYYY aici.
      date: LOOKUP_DATE,

      ecr: ECR_ID,

      addSgrToProduct: "false",
    }),
  }
);

const lookupText = await lookupResponse.text();

console.log("LOOKUP STATUS:", lookupResponse.status);
console.log(
  "LOOKUP CONTENT-TYPE:",
  lookupResponse.headers.get("content-type")
);

// ======================================================
// 3. VALIDARE RĂSPUNS LOOKUP
// ======================================================

if (!lookupResponse.ok) {
  throw new Error(
    `Lookup SmartBill HTTP ${lookupResponse.status}:\n\n` +
      lookupText.slice(0, 2000)
  );
}

let product;

try {
  product = JSON.parse(lookupText);
} catch {
  throw new Error(
    "Lookup-ul SmartBill nu a returnat JSON valid:\n\n" +
      lookupText.slice(0, 2000)
  );
}

if (!product.successfully) {
  throw new Error(
    "Lookup SmartBill a eșuat:\n" +
      JSON.stringify(product, null, 2)
  );
}

// ======================================================
// 4. VALIDARE PRODUS
// ======================================================

if (!product.productCode) {
  throw new Error(
    "SmartBill nu a returnat productCode."
  );
}

if (!product.productName) {
  throw new Error(
    "SmartBill nu a returnat productName."
  );
}

if (!product.warehouses?.length) {
  throw new Error(
    "SmartBill nu a returnat gestiunea produsului."
  );
}

// ======================================================
// 5. GĂSIM PROMENADA
// ======================================================

const warehouse = product.warehouses.find(
  (warehouse) =>
    Number(warehouse.warehouseId) === WAREHOUSE_ID
);

if (!warehouse) {
  throw new Error(
    `Produsul ${SKU} nu a fost găsit în gestiunea ${WAREHOUSE_NAME}.`
  );
}

if (warehouse.name !== WAREHOUSE_NAME) {
  throw new Error(
    `Gestiunea găsită este "${warehouse.name}", ` +
      `dar era așteptată "${WAREHOUSE_NAME}".`
  );
}

// ======================================================
// 6. GĂSIM UM
// ======================================================

const measuringUnit = product.measuringUnits?.find(
  (unit) =>
    Number(unit.id) ===
    Number(product.selectedMeasuringUnitId)
);

if (!measuringUnit) {
  throw new Error(
    "UM-ul produsului nu a fost găsit."
  );
}

// ======================================================
// 7. VALIDĂRI FINALE DIN LOOKUP
// ======================================================

if (!warehouse.vatCode) {
  throw new Error(
    "SmartBill nu a returnat informațiile TVA."
  );
}

if (warehouse.price == null) {
  throw new Error(
    "SmartBill nu a returnat prețul produsului."
  );
}

if (warehouse.isVatIncluded == null) {
  throw new Error(
    "SmartBill nu a returnat informația privind TVA inclus."
  );
}

if (product.productCode !== SKU) {
  throw new Error(
    `SKU mismatch. Cerut: ${SKU}, găsit: ${product.productCode}`
  );
}

// ======================================================
// 8. AFIȘĂM PRODUSUL GĂSIT
// ======================================================

console.log("\n================================");
console.log("PRODUS GĂSIT ÎN SMARTBILL");
console.log("================================");

console.log("SKU:", product.productCode);
console.log("Nume:", product.productName);

console.log(
  "Stock Product ID:",
  product.stockProductId
);

console.log(
  "C Product ID:",
  product.c_product_id
);

console.log("Gestiune:", warehouse.name);

console.log(
  "Stoc:",
  warehouse.availableQuantity
);

console.log(
  "Pret cu TVA:",
  warehouse.price
);

console.log(
  "Pret fara TVA:",
  warehouse.priceWithoutVat
);

console.log(
  "TVA:",
  warehouse.vatCode.name,
  warehouse.vatCode.percentage + "%"
);

console.log(
  "UM:",
  measuringUnit.name
);

console.log(
  "Este serviciu:",
  product.isService
);

// ======================================================
// 9. CONSTRUIM PRODUSUL PENTRU BON
// ======================================================
//
// Shopify -> SKU + quantity
//
// SmartBill lookup ->
// name
// code
// price
// VAT
// UM
// warehouse
//
// ======================================================

const productForReceipt = {
  name: product.productName,

  code: product.productCode,

  quantity: QUANTITY,

  price: Number(warehouse.price),

  currency: "RON",

  measuringUnitName: measuringUnit.name,

  isTaxIncluded: warehouse.isVatIncluded,

  taxName: warehouse.vatCode.name,

  taxPercentage: Number(
    warehouse.vatCode.percentage
  ),

  warehouseName: warehouse.name,

  isService: Boolean(product.isService),

  saveToDb: false,
};

// ======================================================
// 10. CALCUL TOTAL
// ======================================================

const total = Number(
  (Number(warehouse.price) * QUANTITY).toFixed(2)
);

// ======================================================
// 11. AFIȘĂM EXACT PRODUSUL CARE VA FI TRIMIS
// ======================================================

console.log("\n================================");
console.log("PRODUS TRIMIS PE BON");
console.log("================================");

console.log(
  JSON.stringify(
    productForReceipt,
    null,
    2
  )
);

console.log("\nTOTAL:", total);

// ======================================================
// 12. PAYMENT PAYLOAD
// ======================================================

const paymentPayload = {
  companyVatCode,

  type: "Bon",

  value: total,

  currency: "RON",

  // IMPORTANT:
  // Bonul este REAL.
  isDraft: false,

  issueDate: ISSUE_DATE,

  client: {
    name: "Client POS TEST",
  },

  products: [
    productForReceipt,
  ],

  receivedCard: total,

  receivedCash: 0,

  useStock: false,

  returnFiscalPrinterText: false,
};

// ======================================================
// 13. AFIȘĂM PAYLOAD-UL
// ======================================================

console.log("\n================================");
console.log("SMARTBILL PAYMENT PAYLOAD");
console.log("================================");

console.log(
  JSON.stringify(
    paymentPayload,
    null,
    2
  )
);

// ======================================================
// 14. EMITERE BON FISCAL REAL
// ======================================================

console.log("\n================================");
console.log("EMITERE BON FISCAL...");
console.log("================================");

const response = await fetch(
  "https://ws.smartbill.ro/SBORO/api/payment",
  {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      Accept: "application/json",

      Authorization:
        "Basic " +
        Buffer.from(
          `${username}:${token}`
        ).toString("base64"),
    },

    body: JSON.stringify(
      paymentPayload
    ),
  }
);

const responseText = await response.text();

// ======================================================
// 15. REZULTAT
// ======================================================

console.log("\n================================");
console.log("BON FISCAL");
console.log("================================");

console.log(
  "STATUS:",
  response.status
);

console.log(responseText);
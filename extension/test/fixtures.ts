/** Mock-POS-shaped markup (same structure as backend/src/mock.ts and brief 4.1). */
export const ID = {
  order: "8493a649-aee9-4bb9-a4f6-9adbb222d2d6",
  trouser: "11111111-1111-4111-8111-111111111111",
  shirt: "22222222-2222-4222-8222-222222222222",
  alt: "33333333-3333-4333-8333-333333333333",
};

export function row(id: string | null, desc: string, qty = 1): string {
  return `<tr data-uid="u-${desc}"${id ? ` data-id="${id}"` : ""}>
    <td data-field="plu">P</td><td data-field="description">${desc}</td><td data-field="size">-</td>
    <td data-field="colour">-</td><td data-field="quantity">${qty}</td><td data-field="unitprice">1.00</td></tr>`;
}

export function page(rows: string, status = "Awaiting Payment", orderId: string | null = ID.order): string {
  return `<body${orderId ? ` data-order-id="${orderId}"` : ""} data-order-status="${status}">
    <table id="pos-grid"><tbody>${rows}</tbody></table><button id="pay">Pay</button></body>`;
}

export const standard = () =>
  page(row(ID.trouser, "PERM PRESS TROUSERS") + row(ID.shirt, "COTTON SHIRT", 2) + row(ID.alt, "SHORTEN TROUSER"));

/**
 * Mock Retail Express POS (demo only, ENABLE_MOCK=true).
 *
 * Mirrors the grid structure observed in the brief (tr[data-uid][data-id],
 * td[data-field]) and the order lifecycle the extension must survive: a live
 * sale is identified by a session GUID (brief 4.2); after completion the page
 * shows the order number, with the same OrderItemIds. Never presented as RE.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "./db/types.js";

export const PRODUCTS: Record<number, { description: string; plu: string; size: string; colour: string; price: number }> = {
  146344: { description: "PERM PRESS TROUSERS", plu: "TRYK02594", size: "97S", colour: "NAVY", price: 110 },
  140599: { description: "COTTON SHIRT", plu: "SHTC1100", size: "39", colour: "WHITE", price: 79 },
  158210: { description: "WOOL JACKET", plu: "JKTW8800", size: "98R", colour: "CHARCOAL", price: 349 },
  900001: { description: "SHORTEN TROUSER", plu: "ALTSHT01", size: "-", colour: "-", price: 25 },
  900002: { description: "WAIST ALTERATION", plu: "ALTWST02", size: "-", colour: "-", price: 20 },
};

export interface MockOrder {
  order_id: string;
  session_guid: string | null;
  status: string;
}

export class MockPos {
  private orders: string;
  private items: string;

  constructor(private db: Db, schema: string) {
    this.orders = `${schema}.rex_orders`;
    this.items = `${schema}.rex_order_items`;
  }

  /** Never reuse an order number, even after the mock is wiped (real RE doesn't). */
  private async nextOrderNumber(q: Queryable, now = Date.now()): Promise<string> {
    const yy = String(new Date(now).getUTCFullYear()).slice(2);
    const max = (await q.query<{ m: number | null }>(
      `SELECT MAX(substr(order_id, 4)::int) AS m FROM ${this.orders} WHERE order_id LIKE $1`,
      [`${yy}-%`])).rows[0].m ?? 0;
    const seq = Math.max(max + 1, Math.floor(now / 1000) % 1e8);
    return `${yy}-${String(seq).padStart(8, "0")}`;
  }

  async newOrder(now?: number): Promise<{ orderId: string }> {
    const guid = randomUUID();
    await this.db.transaction(async (q) => {
      await q.query(`INSERT INTO ${this.orders} (order_id, session_guid, status) VALUES ($1, $2, 'Awaiting Payment')`,
                    [await this.nextOrderNumber(q, now), guid]);
    });
    return { orderId: guid };
  }

  async find(ident: string | undefined): Promise<MockOrder | null> {
    if (!ident) return null;
    return (await this.db.query<MockOrder>(
      `SELECT order_id, session_guid, status FROM ${this.orders} WHERE order_id = $1 OR session_guid = $1`,
      [ident])).rows[0] ?? null;
  }

  async latest(): Promise<MockOrder | null> {
    return (await this.db.query<MockOrder>(
      `SELECT order_id, session_guid, status FROM ${this.orders} ORDER BY created_at DESC, order_id DESC LIMIT 1`))
      .rows[0] ?? null;
  }

  /** Live sale shows the session GUID; a completed sale shows its order number. */
  static shownId(o: MockOrder): string {
    return o.session_guid && o.status !== "Completed" ? o.session_guid : o.order_id;
  }

  async addItem(ident: string, productId: number, qty = 1) {
    const order = await this.find(ident);
    if (!order) return { error: "Unknown orderId", status: 404 as const };
    const p = PRODUCTS[productId];
    if (!p) return { error: `Unknown ProductId ${productId}`, status: 404 as const };
    const itemId = randomUUID();
    await this.db.query(
      `INSERT INTO ${this.items} (order_item_id, order_id, product_id, description, size, colour, plu, qty, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [itemId, order.order_id, productId, p.description, p.size, p.colour, p.plu, qty, p.price]);
    await this.db.query(`UPDATE ${this.orders} SET order_total = order_total + $1 WHERE order_id = $2`,
                        [p.price * qty, order.order_id]);
    // Mirrors the response shape observed in the brief (4.3).
    return {
      item: {
        OrderItemId: itemId, Uid: randomUUID(), ProductId: productId, Code: p.plu, Description: p.description,
        Size: p.size, Colour: p.colour, Quantity: qty, UnitPrice: p.price, DeliveryMode: "store",
      },
    };
  }

  async complete(ident: string) {
    const order = await this.find(ident);
    if (!order) return null;
    await this.db.query(`UPDATE ${this.orders} SET status = 'Completed' WHERE order_id = $1`, [order.order_id]);
    return { orderId: order.order_id, status: "Completed" };
  }

  async lines(orderNumber: string) {
    return (await this.db.query<{ order_item_id: string; description: string; size: string; colour: string;
                                  plu: string; qty: number; unit_price: string }>(
      `SELECT order_item_id, description, size, colour, plu, qty, unit_price FROM ${this.items}
        WHERE order_id = $1 ORDER BY seq`, [orderNumber])).rows;
  }

  async reset(): Promise<void> {
    await this.db.exec(`TRUNCATE ${this.items}, ${this.orders}`);
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function posPage(order: MockOrder, lines: Awaited<ReturnType<MockPos["lines"]>>): string {
  const shown = MockPos.shownId(order);
  const rows = lines.map((l, i) => `
    <tr data-uid="${esc(`${order.order_id}-${i}`)}" data-id="${esc(l.order_item_id)}">
      <td data-field="plu">${esc(l.plu)}</td><td data-field="description">${esc(l.description)}</td>
      <td data-field="size">${esc(l.size)}</td><td data-field="colour">${esc(l.colour)}</td>
      <td data-field="quantity">${esc(l.qty)}</td><td data-field="unitprice">${Number(l.unit_price).toFixed(2)}</td>
    </tr>`).join("");
  const options = Object.entries(PRODUCTS)
    .map(([id, p]) => `<option value="${id}">${esc(p.description)} (${id})</option>`).join("");
  const completed = order.status === "Completed";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MOCK POS (not Retail Express)</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1d2321}
  #mock-banner{background:#b3261e;color:#fff;font-weight:700;text-align:center;padding:6px;letter-spacing:.04em}
  header{display:flex;gap:12px;align-items:center;padding:10px 16px;background:#123c5c;color:#fff}
  header h1{font-size:16px;margin:0}
  #order-badge{margin-left:auto;font-family:monospace;font-size:12px}
  #saved-link{color:#cfe3f5;font-size:12px}
  .toolbar{display:flex;gap:8px;padding:12px 16px;align-items:center;flex-wrap:wrap}
  button,select{font:13px system-ui;padding:6px 10px;border-radius:4px;border:1px solid #b9c2cc;background:#fff}
  button.primary{background:#1f7a4d;color:#fff;border-color:#1f7a4d}
  table{border-collapse:collapse;width:calc(100% - 376px);margin:0 16px;background:#fff}
  th,td{border:1px solid #d4dae0;padding:6px 8px;text-align:left;font-size:13px}
  th{background:#eef1f4}
</style></head>
<body data-order-id="${esc(shown)}" data-order-status="${esc(order.status)}">
<div id="mock-banner">MOCK &ndash; not Retail Express &middot; demo data only</div>
<header>
  <h1>POS mock</h1>
  <span id="order-badge">Order: ${esc(shown)} &middot; ${esc(order.status)}</span>
  <a id="saved-link" href="/pos/saved?order_id=${encodeURIComponent(shown)}" target="_blank" rel="noopener">Saved data</a>
</header>
<div class="toolbar">
  <button class="primary" id="new-order">New sale</button>
  <label>Product: <select id="product-pick">${options}</select></label>
  <button id="add-item"${completed ? " disabled" : ""}>Add product</button>
  ${completed ? "" : '<button id="complete-sale">Complete sale</button>'}
</div>
<table id="pos-grid"><thead><tr><th>PLU</th><th>Description</th><th>Size</th><th>Colour</th><th>Qty</th><th>Price</th></tr></thead>
<tbody>${rows}</tbody></table>
<script>
  window.__REX_ORDER_ID = ${JSON.stringify(shown)};
  const post = (url, body) => fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
                                          body: JSON.stringify(body || {})}).then(r => r.json());
  document.getElementById('new-order').onclick = async () => {
    const d = await post('/rex/mock/pos/new-order');
    location.href = '/pos?order_id=' + encodeURIComponent(d.orderId);
  };
  const done = document.getElementById('complete-sale');
  if (done) done.onclick = async () => {
    const d = await post('/rex/mock/pos/complete', {orderId: window.__REX_ORDER_ID});
    location.href = '/pos?order_id=' + encodeURIComponent(d.orderId);
  };
  document.getElementById('add-item').onclick = async () => {
    const pid = parseInt(document.getElementById('product-pick').value, 10);
    const d = await post('/rex/mock/pos/add-item', {items: [{ProductId: pid, Quantity: 1}], orderId: window.__REX_ORDER_ID});
    if (!d.OrderItemId) { alert('add failed: ' + (d.Error || 'unknown')); return; }
    const tr = document.createElement('tr');
    tr.dataset.uid = d.Uid; tr.dataset.id = d.OrderItemId;
    for (const [f, v] of [['plu', d.Code], ['description', d.Description], ['size', d.Size], ['colour', d.Colour],
                          ['quantity', d.Quantity], ['unitprice', Number(d.UnitPrice).toFixed(2)]]) {
      const td = document.createElement('td'); td.dataset.field = f; td.textContent = v; tr.appendChild(td);
    }
    document.querySelector('#pos-grid tbody').appendChild(tr);
  };
</script>
</body></html>`;
}

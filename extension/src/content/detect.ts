/**
 * Read the order and its lines from the page. Layered: network payloads first
 * (brief 4.2/4.3), then DOM attributes, then the URL. Selectors: selectors.ts only.
 */
import { SEL } from "../selectors.js";

export interface Line {
  el: HTMLElement;
  orderItemId: string;
  description: string;
  quantity: number;
}

/** Ids seen in network traffic (filled from the MAIN-world page hook). */
export interface PayloadState {
  orderId: string | null;
  items: { orderItemId: string; description: string | null }[];
}

export function newPayloadState(): PayloadState {
  return { orderId: null, items: [] };
}

/** Pull orderId / OrderItemId out of one intercepted request or response body. */
export function scanPayload(state: PayloadState, text: string | null | undefined): void {
  if (!text) return;
  const oid = text.match(SEL.payloadOrderId);
  if (oid) state.orderId = oid[1];
  const iid = text.match(SEL.payloadItemId);
  if (iid) {
    const desc = text.match(SEL.payloadDescription);
    state.items.push({ orderItemId: iid[1], description: desc ? desc[1] : null });
    if (state.items.length > 50) state.items.shift();
  }
}

export function detectOrderId(doc: Document, payload: PayloadState, search = doc.location?.search ?? ""): string | null {
  if (payload.orderId) return payload.orderId;
  const el = doc.querySelector(SEL.orderIdEl);
  const fromDom = el?.getAttribute(SEL.orderIdAttr);
  if (fromDom) return fromDom;
  return new URLSearchParams(search).get(SEL.orderUrlParam);
}

export function detectOrderStatus(doc: Document): string | null {
  return doc.querySelector(SEL.orderStatusEl)?.getAttribute(SEL.orderStatusAttr) ?? null;
}

function text(row: Element, field: Parameters<typeof SEL.field>[0]): string {
  return row.querySelector(SEL.field(field))?.textContent?.trim() ?? "";
}

export function rowQuantity(row: Element): number {
  const n = parseInt(text(row, "quantity"), 10);
  return Number.isNaN(n) ? 1 : n;
}

/** Lines with their OrderItemId: DOM line ids first, payload-matched rows second. */
export function detectLines(doc: Document, payload: PayloadState): Line[] {
  const rows = [...doc.querySelectorAll<HTMLElement>(SEL.lineRow)];
  if (rows.length) {
    return rows.map((el) => ({
      el,
      orderItemId: el.getAttribute(SEL.lineIdAttr)!,
      description: text(el, "description"),
      quantity: rowQuantity(el),
    }));
  }
  // Rows without a line id: match intercepted payload items by description.
  const used = new Set<number>();
  const out: Line[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>(SEL.anyLineRow)) {
    const desc = text(el, "description");
    const i = payload.items.findIndex((p, j) => !used.has(j) && p.description === desc);
    if (desc && i >= 0) {
      used.add(i);
      out.push({ el, orderItemId: payload.items[i].orderItemId, description: desc, quantity: rowQuantity(el) });
    }
  }
  return out;
}

/** Any sale-line rows on the page at all (with or without ids)? */
export function countAnyRows(doc: Document): number {
  return doc.querySelectorAll(SEL.anyLineRow).length;
}

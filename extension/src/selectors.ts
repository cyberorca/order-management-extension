/**
 * Every Retail Express page selector and attribute lives here (CLAUDE.md
 * resilience rule) - nothing else in the extension may contain one, and a
 * test enforces it. Stable attributes only (data-id, data-field), never class
 * names or positions. Observed on the mock and in the brief (4.1-4.3); the
 * real RE page is a Phase 0 item, so these are assumptions until verified.
 */
export const SEL = {
  /** A sale line carrying its OrderItemId (brief 4.1: data-id == OrderItemId). */
  lineRow: "tr[data-id]",
  lineIdAttr: "data-id",
  /** Any sale line, with or without an id - used by the health check. */
  anyLineRow: "tr:has(td[data-field])",
  field: (name: "plu" | "description" | "size" | "colour" | "quantity") => `[data-field="${name}"]`,
  /** Order identifier in the DOM (layer 2; layer 1 is network payloads). */
  orderIdEl: "[data-order-id]",
  orderIdAttr: "data-order-id",
  /** Order status; "Completed" locks the sidecar structure. RE signal: Phase 0. */
  orderStatusEl: "[data-order-status]",
  orderStatusAttr: "data-order-status",
  completedStatus: "Completed",
  /** Order identifier in the URL (layer 3). */
  orderUrlParam: "order_id",
  /** Network payload fields (brief 4.2/4.3). */
  payloadOrderId: /"orderId"\s*:\s*"([^"]+)"/,
  payloadItemId: /"OrderItemId"\s*:\s*"([^"]+)"/,
  payloadDescription: /"Description"\s*:\s*"([^"]+)"/,
  /** Only order-related traffic is inspected. */
  payloadUrlFilter: /order/i,
} as const;

/**
 * Health check (page-resilience spec): does the page still look the way the
 * extension expects? Missing pieces -> visible warning + backend report, never
 * silent. Reports carry check results only: no customer data, no line contents.
 */
import type { HealthReport } from "../shared/messages.js";
import { countAnyRows, detectLines, detectOrderId, type PayloadState } from "./detect.js";

export interface Health {
  /** Looks like a sale screen at all (an order id or sale rows). Not one -> stay silent. */
  saleScreen: boolean;
  ok: boolean;
  checks: Record<string, boolean>;
}

export function checkHealth(doc: Document, payload: PayloadState): Health {
  const orderId = !!detectOrderId(doc, payload, "");
  const rows = countAnyRows(doc);
  const lines = detectLines(doc, payload).length;
  const checks = {
    orderId,
    // An empty sale has no rows yet - that is fine. Rows without ids are not.
    lineIds: rows === 0 || lines > 0,
  };
  return { saleScreen: orderId || rows > 0, ok: Object.values(checks).every(Boolean), checks };
}

export function healthReport(checks: Record<string, boolean>, version: string, path: string): HealthReport {
  return { ext_version: version, path: path.slice(0, 200), checks };
}

export const WARNING_ID = "ome-health-warning";

export function showWarning(doc: Document, checks: Record<string, boolean>): void {
  if (doc.getElementById(WARNING_ID)) return;
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
  const el = doc.createElement("div");
  el.id = WARNING_ID;
  el.setAttribute("role", "status");
  el.textContent = `Order Links: page not recognised (${missing}). Wearer controls are off; Retail Express works as normal.`;
  doc.body.appendChild(el);
}

export function clearWarning(doc: Document): void {
  doc.getElementById(WARNING_ID)?.remove();
}

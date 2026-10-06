// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { detectLines, detectOrderId, detectOrderStatus, newPayloadState, scanPayload } from "../src/content/detect.js";
import { checkHealth } from "../src/content/health.js";
import { ID, page, row, standard } from "./fixtures.js";

beforeEach(() => { document.documentElement.innerHTML = ""; });
const load = (html: string) => { document.documentElement.innerHTML = html; };

describe("detection", () => {
  it("finds every line with its OrderItemId and quantity", () => {
    load(standard());
    const lines = detectLines(document, newPayloadState());
    expect(lines.map((l) => [l.orderItemId, l.description, l.quantity])).toEqual([
      [ID.trouser, "PERM PRESS TROUSERS", 1], [ID.shirt, "COTTON SHIRT", 2], [ID.alt, "SHORTEN TROUSER", 1]]);
  });

  it("duplicate products get distinct ids", () => {
    load(page(row(ID.trouser, "PERM PRESS TROUSERS") + row(ID.shirt, "PERM PRESS TROUSERS")));
    expect(new Set(detectLines(document, newPayloadState()).map((l) => l.orderItemId)).size).toBe(2);
  });

  it("order id: payload first, then DOM, then URL", () => {
    load(standard());
    const p = newPayloadState();
    expect(detectOrderId(document, p)).toBe(ID.order);
    scanPayload(p, '{"items":[{"ProductId":1}],"orderId":"from-payload"}');
    expect(detectOrderId(document, p)).toBe("from-payload");
    load(page("", "x", null));
    expect(detectOrderId(document, newPayloadState(), "?order_id=from-url")).toBe("from-url");
  });

  it("reads the order status", () => {
    load(standard().replace("Awaiting Payment", "Completed"));
    expect(detectOrderStatus(document)).toBe("Completed");
  });

  it("falls back to payload ids for rows without data-id", () => {
    load(page(row(null, "COTTON SHIRT")));
    const p = newPayloadState();
    scanPayload(p, `{"OrderItemId":"${ID.shirt}","Description":"COTTON SHIRT"}`);
    expect(detectLines(document, p).map((l) => l.orderItemId)).toEqual([ID.shirt]);
  });
});

describe("health check", () => {
  it("page matches expectations", () => {
    load(standard());
    expect(checkHealth(document, newPayloadState())).toMatchObject({ saleScreen: true, ok: true });
  });

  it("an empty sale is healthy", () => {
    load(page(""));
    expect(checkHealth(document, newPayloadState()).ok).toBe(true);
  });

  it("line identifiers missing -> not ok, names the missing check", () => {
    load(page(row(null, "PERM PRESS TROUSERS") + row(null, "COTTON SHIRT")));
    const h = checkHealth(document, newPayloadState());
    expect(h).toMatchObject({ saleScreen: true, ok: false, checks: { orderId: true, lineIds: false } });
  });

  it("not a sale screen -> stays silent", () => {
    load("<body><p>Reports</p></body>");
    expect(checkHealth(document, newPayloadState()).saleScreen).toBe(false);
  });
});

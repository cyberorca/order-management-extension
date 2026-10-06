// @vitest-environment happy-dom
/** Fail-safe, debounced change detection, health warning, and panel behaviour. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/content/main.js";
import { Panel, QTY_WARNING } from "../src/content/panel.js";
import { detectLines, newPayloadState } from "../src/content/detect.js";
import type { OrderState, Request } from "../src/shared/messages.js";
import { ID, page, row, standard } from "./fixtures.js";

const state = (links: OrderState["links"] = [], extra: Partial<OrderState> = {}): OrderState =>
  ({ order_id: ID.order, order_ref: 1, version: links.length, completed: false, aliases: [ID.order], links, ...extra });
const link = (id: string, wearer: string | null, parent: string | null = null, note: string | null = null) =>
  ({ order_item_id: id, wearer, wearer_id: wearer ? 1 : null, parent_order_item_id: parent, note, orphaned: false });

const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));
let stop: (() => void) | undefined;

function bridge(handler: (req: Request) => unknown = (req) =>
  req.type === "lookup" ? { kind: "ok", data: state() } : undefined) {
  const sent: Request[] = [];
  return { sent, send: vi.fn(async (req: Request) => { sent.push(req); return handler(req); }) };
}
const dialogs = { prompt: vi.fn(() => "James"), confirm: vi.fn(() => true) };

beforeEach(() => { document.documentElement.innerHTML = standard(); dialogs.prompt.mockClear(); dialogs.confirm.mockClear(); });
afterEach(() => { stop?.(); stop = undefined; });

describe("start", () => {
  it("adds controls and the panel on a recognised page", async () => {
    const b = bridge();
    stop = start({ doc: document, win: window, bridge: b, dialogs, version: "0.1.0" }).stop;
    await settle();
    expect(document.querySelectorAll(".ome-assign")).toHaveLength(3);
    expect(document.getElementById("ome-panel")).not.toBeNull();
    expect(b.sent.filter((r) => r.type === "lookup")).toHaveLength(1);
  });

  it("a burst of 5 row changes triggers one lookup", async () => {
    const b = bridge();
    stop = start({ doc: document, win: window, bridge: b, dialogs, version: "0.1.0" }).stop;
    await settle();
    const tbody = document.querySelector("tbody")!;
    for (let i = 0; i < 5; i++) {
      const parse = document.createElement("tbody"); // parse <tr> in table context
      parse.innerHTML = row(`id-${i}`, `ITEM ${i}`);
      tbody.appendChild(parse.firstElementChild!);
    }
    await settle();
    expect(b.sent.filter((r) => r.type === "lookup")).toHaveLength(2);
    expect(document.querySelectorAll(".ome-assign")).toHaveLength(8);
  });

  it("line ids missing: visible warning, no controls, one health report", async () => {
    document.documentElement.innerHTML = page(row(null, "PERM PRESS TROUSERS"));
    const b = bridge();
    stop = start({ doc: document, win: window, bridge: b, dialogs, version: "0.1.0" }).stop;
    await settle();
    expect(document.getElementById("ome-health-warning")?.textContent).toContain("lineIds");
    expect(document.querySelectorAll(".ome-cellbtn")).toHaveLength(0);
    const reports = b.sent.filter((r) => r.type === "health");
    expect(reports).toHaveLength(1);
    const json = JSON.stringify(reports[0]);
    expect(json).not.toContain("PERM PRESS"); // no line contents / customer data
    expect(json).toContain('"lineIds":false');
  });

  it("fail-safe: an error removes everything and leaves the page usable", async () => {
    const b = bridge((req) => { if (req.type === "lookup") throw new Error("boom"); return undefined; });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = document.querySelector("tbody")!.innerHTML;
    const ctl = start({ doc: document, win: window, bridge: b, dialogs, version: "0.1.0" });
    stop = ctl.stop;
    await settle();
    expect(ctl.disabled()).toBe(true);
    expect(document.getElementById("ome-panel")).toBeNull();
    expect(document.querySelectorAll(".ome-cellbtn")).toHaveLength(0);
    expect(document.querySelector("tbody")!.innerHTML.replace(/ class="[^"]*"/g, "")).toBe(before);
    expect(b.sent.some((r) => r.type === "health")).toBe(true);
    let clicked = false;
    document.getElementById("pay")!.addEventListener("click", () => { clicked = true; });
    document.getElementById("pay")!.click();
    expect(clicked).toBe(true);
  });

  it("completed status: lookup first, then complete", async () => {
    document.documentElement.innerHTML = standard().replace("Awaiting Payment", "Completed");
    const b = bridge((req) => ({ kind: "ok", data: state([], { completed: req.type === "complete" }) }));
    stop = start({ doc: document, win: window, bridge: b, dialogs, version: "0.1.0" }).stop;
    await settle();
    expect(b.sent.filter((r) => r.type !== "health").map((r) => r.type)).toEqual(["lookup", "complete"]);
  });
});

describe("panel", () => {
  function panel(handler?: (req: Request) => unknown) {
    const b = bridge(handler);
    const p = new Panel(document, b, dialogs);
    p.orderId = ID.order;
    p.rows = detectLines(document, newPayloadState());
    p.injectControls();
    return { p, b };
  }

  it("draws an alteration once, under its garment's wearer", () => {
    const { p } = panel();
    p.apply(state([link(ID.trouser, "James"), link(ID.alt, null, ID.trouser), link(ID.shirt, "Andi")]));
    const view = [...document.querySelectorAll("#ome-view > div")].map((d) => d.className.split(" ")[0] + ":" + (d.getAttribute("data-item") ?? d.textContent));
    expect(view).toEqual([
      "ome-wearer:Andi", `ome-line:${ID.shirt}`,
      "ome-wearer:James", `ome-line:${ID.trouser}`, `ome-line:${ID.alt}`,
    ]);
    expect(document.querySelector(`[data-item="${ID.alt}"]`)!.className).toContain("ome-child");
    expect(document.body.textContent).not.toContain("Unassigned");
  });

  it("quantity 2 warns before assigning; quantity 1 does not", async () => {
    const { p, b } = panel((req) => req.type === "write" ? { kind: "ok", data: state() } : undefined);
    dialogs.confirm.mockReturnValueOnce(false);
    (document.querySelectorAll(".ome-assign")[1] as HTMLElement).click(); // shirt, qty 2
    await settle(10);
    expect(dialogs.confirm).toHaveBeenCalledWith(QTY_WARNING(2));
    expect(b.sent.some((r) => r.type === "write")).toBe(false);
    dialogs.confirm.mockClear();
    (document.querySelectorAll(".ome-assign")[0] as HTMLElement).click(); // trouser, qty 1
    await settle(10);
    expect(dialogs.confirm).not.toHaveBeenCalled();
    const w = b.sent.find((r) => r.type === "write") as Extract<Request, { type: "write" }>;
    expect(w.body).toMatchObject({ wearer: "James", version: 0, lines: [ID.trouser, ID.shirt, ID.alt] });
    void p;
  });

  it("alteration: click the button, then the garment row", async () => {
    const { b } = panel((req) => req.type === "write" ? { kind: "ok", data: state() } : undefined);
    (document.querySelectorAll(".ome-alt")[2] as HTMLElement).click();
    (document.querySelectorAll("tbody tr")[0].querySelector("td") as HTMLElement).click();
    await settle(10);
    const w = b.sent.find((r) => r.type === "write") as Extract<Request, { type: "write" }>;
    expect(w.path).toBe(`/api/orders/${ID.order}/items/${ID.alt}/link`);
    expect(w.body.parent_order_item_id).toBe(ID.trouser);
  });

  it("locked: shows the lock banner and resends with override when confirmed", async () => {
    let n = 0;
    const { b } = panel((req) => req.type === "write"
      ? (n++ === 0 ? { kind: "locked", current: state([], { completed: true }) } : { kind: "ok", data: state() })
      : undefined);
    (document.querySelectorAll(".ome-assign")[0] as HTMLElement).click();
    await settle(10);
    const writes = b.sent.filter((r) => r.type === "write") as Extract<Request, { type: "write" }>[];
    expect(writes).toHaveLength(2);
    expect(writes[1].body.override).toBe(true);
  });

  it("queued edits: shows the waiting count, never the edit as saved", async () => {
    const { p } = panel((req) => req.type === "write" ? { kind: "queued", waiting: 1 } : undefined);
    p.apply(state());
    (document.querySelectorAll(".ome-assign")[0] as HTMLElement).click();
    await settle(10);
    expect(document.querySelector(".ome-banner-offline")?.textContent).toContain("1 edit(s) waiting");
    expect(document.getElementById("ome-view")!.textContent).not.toContain("James");
  });

  it("replay conflict: shows the other version and offers discard", () => {
    const { p } = panel();
    p.setQueue({ signedIn: true, waiting: 2, blocked: [{ orderId: ID.order, kind: "conflict",
                                                          current: state([link(ID.trouser, "Michael")]) }] });
    expect(document.querySelector(".ome-banner-conflict")?.textContent).toContain("Discard my queued edits");
    expect(document.getElementById("ome-view")!.textContent).toContain("Michael");
  });

  it("signed out: sign-in prompt", async () => {
    const { p, b } = panel((req) => req.type === "write" ? { kind: "signin" } : undefined);
    p.apply(state());
    (document.querySelectorAll(".ome-assign")[0] as HTMLElement).click();
    await settle(10);
    const banner = document.querySelector(".ome-banner-signin")!;
    expect(banner.textContent).toContain("not saved");
    (banner.querySelector("button") as HTMLElement).click();
    expect(b.sent.at(-1)).toEqual({ type: "openOptions" });
  });
});

describe("changed quantity", () => {
  it("warns using the quantity shown at click time", async () => {
    const b = bridge((req) => req.type === "write" ? { kind: "ok", data: state() } : undefined);
    const p = new Panel(document, b, dialogs);
    p.orderId = ID.order;
    p.rows = detectLines(document, newPayloadState());
    p.injectControls();
    document.querySelectorAll('tbody tr')[0].querySelector('td:nth-child(5)')!.textContent = "3";
    dialogs.confirm.mockReturnValueOnce(false);
    (document.querySelectorAll(".ome-assign")[0] as HTMLElement).click();
    await settle(10);
    expect(dialogs.confirm).toHaveBeenCalledWith(QTY_WARNING(3));
  });
});

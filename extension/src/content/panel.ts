/**
 * Side panel + per-line controls. UI only: every rule lives in the backend;
 * every call goes through the service worker (bridge). Ported from the
 * Python POC panel (grouping by effective wearer, quantity warning, notes,
 * lock + override, orphan / foreign-line banners).
 */
import type { Link, OrderState, Outcome, QueueStatus, Request } from "../shared/messages.js";
import { type Line, rowQuantity } from "./detect.js";

export interface Bridge {
  send(req: Request): Promise<any>;
}

export interface Dialogs {
  prompt(message: string, value: string): string | null;
  confirm(message: string): boolean;
}

type BannerKind = "warn" | "error" | "lock" | "offline" | "signin" | "conflict";
interface Banner { kind: BannerKind; text: string; action?: { label: string; run: () => void } }

export const PANEL_ID = "ome-panel";
const UN = "\u0000unassigned";

export const QTY_WARNING = (n: number) =>
  `This line has quantity ${n}. One line belongs to one wearer.\n\n` +
  "For a second person, add the product again as its own line.\n\nAssign anyway?";

export class Panel {
  orderId: string | null = null;
  version = 0;
  completed = false;
  links: Link[] = [];
  rows: Line[] = [];
  private pending: string | null = null;
  private banner: Banner | null = null;
  private queue: QueueStatus = { signedIn: true, waiting: 0, blocked: [] };
  private onDocClick = (ev: MouseEvent) => this.completeLink(ev);

  constructor(private doc: Document, private bridge: Bridge, private dialogs: Dialogs) {
    doc.addEventListener("click", this.onDocClick, true);
  }

  // ------------------------------------------------------------ lifecycle

  /** Remove everything the extension added (fail-safe and teardown). */
  destroy(): void {
    this.doc.removeEventListener("click", this.onDocClick, true);
    this.doc.getElementById(PANEL_ID)?.remove();
    this.clearControls();
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const n = this.doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  private ensurePanel(): HTMLElement {
    let p = this.doc.getElementById(PANEL_ID);
    if (p) return p;
    p = this.el("div");
    p.id = PANEL_ID;
    const head = this.el("div", "ome-head");
    head.append(this.el("strong", undefined, "Order Links"), Object.assign(this.el("span", "ome-order"), { id: "ome-order" }));
    const banners = this.el("div");
    banners.id = "ome-banners";
    const hint = this.el("div", "ome-hint");
    hint.id = "ome-hint";
    hint.hidden = true;
    const view = this.el("div");
    view.id = "ome-view";
    const foot = this.el("div", "ome-foot");
    foot.id = "ome-foot";
    p.append(head, banners, hint, view, foot);
    this.doc.body.appendChild(p);
    return p;
  }

  // -------------------------------------------------------------- banners

  private setBanner(b: Banner | null): void {
    this.banner = b;
    this.renderBanners();
  }

  private renderBanners(): void {
    const box = this.doc.getElementById("ome-banners");
    if (!box) return;
    box.replaceChildren();
    const shown: Banner[] = [];
    if (this.banner) shown.push(this.banner);
    if (!this.queue.signedIn && this.banner?.kind !== "signin") {
      shown.push({ kind: "signin", text: "Signed out: sign in to save changes. ",
                   action: { label: "Sign in", run: () => void this.bridge.send({ type: "openOptions" }) } });
    }
    const blocked = this.queue.blocked.find((b) => b.orderId === this.orderId);
    if (blocked) {
      shown.push({
        kind: "conflict",
        text: blocked.kind === "locked"
          ? "Queued edits stopped: this order was completed meanwhile. "
          : "Queued edits stopped: someone else changed this order meanwhile. Showing their version. ",
        action: { label: "Discard my queued edits", run: () => void this.discard() },
      });
    } else if (this.queue.waiting > 0) {
      shown.push({ kind: "offline", text: `Backend unreachable: ${this.queue.waiting} edit(s) waiting, not saved yet. `,
                   action: { label: "Retry", run: () => void this.retry() } });
    }
    for (const b of shown) {
      const div = this.el("div", `ome-banner ome-banner-${b.kind}`, b.text);
      if (b.action) {
        const btn = this.el("button", "ome-banner-action", b.action.label);
        btn.type = "button";
        btn.addEventListener("click", b.action.run);
        div.appendChild(btn);
      }
      box.appendChild(div);
    }
  }

  // ----------------------------------------------------------------- view

  private label(id: string): string {
    const row = this.rows.find((r) => r.orderItemId === id);
    if (row?.description) return row.description;
    const link = this.links.find((l) => l.order_item_id === id);
    return link?.orphaned ? `${id.slice(0, 8)} (line removed)` : id.slice(0, 8);
  }

  private lineNode(link: Link, child: boolean): HTMLElement {
    const n = this.el("div", `ome-line${child ? " ome-child" : ""}${link.orphaned ? " ome-orphan" : ""}`);
    n.dataset.item = link.order_item_id;
    n.append(this.el("span", "ome-line-id", `[${link.order_item_id.slice(0, 8)}]`), this.el("span", undefined, ` ${this.label(link.order_item_id)}`));
    if (link.orphaned) n.appendChild(this.el("span", "ome-tag", "orphaned"));
    if (link.note) n.appendChild(this.el("div", "ome-note-text", link.note));
    return n;
  }

  /**
   * Group by effective wearer: an alteration usually has no wearer of its own
   * and is drawn under its garment. Display only - nothing copied to storage.
   */
  render(): void {
    this.ensurePanel();
    const view = this.doc.getElementById("ome-view")!;
    view.replaceChildren();
    if (!this.links.length) {
      view.appendChild(this.el("div", "ome-empty", "No wearer links yet."));
    } else {
      const byId = new Map(this.links.map((l) => [l.order_item_id, l]));
      const kids = new Map<string, Link[]>();
      for (const l of this.links) {
        if (l.parent_order_item_id) kids.set(l.parent_order_item_id, [...(kids.get(l.parent_order_item_id) ?? []), l]);
      }
      const groupOf = (l: Link | undefined): string => {
        const seen = new Set<string>();
        while (l && !seen.has(l.order_item_id)) {
          if (l.wearer) return l.wearer;
          seen.add(l.order_item_id);
          l = l.parent_order_item_id ? byId.get(l.parent_order_item_id) : undefined;
        }
        return UN;
      };
      const groups = new Map<string, Link[]>();
      for (const l of this.links) groups.set(groupOf(l), [...(groups.get(groupOf(l)) ?? []), l]);
      const drawn = new Set<string>();
      const draw = (l: Link, depth: number, w: string) => {
        if (drawn.has(l.order_item_id)) return; // guards cycles and double drawing
        drawn.add(l.order_item_id);
        view.appendChild(this.lineNode(l, depth > 0));
        for (const c of kids.get(l.order_item_id) ?? []) if (groupOf(c) === w) draw(c, depth + 1, w);
      };
      for (const w of [...groups.keys()].sort()) {
        view.appendChild(this.el("div", `ome-wearer${w === UN ? " ome-unassigned" : ""}`, w === UN ? "Unassigned" : w));
        for (const l of groups.get(w)!) {
          const parent = l.parent_order_item_id ? byId.get(l.parent_order_item_id) : undefined;
          if (!parent || groupOf(parent) !== w) draw(l, parent ? 1 : 0, w);
        }
        for (const l of groups.get(w)!) draw(l, 0, w);
      }
    }
    this.doc.getElementById("ome-order")!.textContent = `${this.orderId ?? "-"}${this.completed ? " · completed" : ""}`;
    this.doc.getElementById("ome-foot")!.textContent =
      `${this.rows.length} lines · ${this.links.length} links · v${this.version}`;
    this.renderBanners();
  }

  // ------------------------------------------------------------- controls

  private clearControls(): void {
    this.doc.querySelectorAll(".ome-cellbtn").forEach((b) => b.remove());
    this.doc.querySelectorAll(".ome-row").forEach((r) => r.classList.remove("ome-row", "ome-linkmode"));
  }

  injectControls(): void {
    this.clearControls();
    for (const r of this.rows) {
      const td = r.el.lastElementChild;
      if (!td) continue;
      r.el.classList.add("ome-row");
      const add = (cls: string, label: string, title: string, run: () => void) => {
        const b = this.el("button", `ome-cellbtn ${cls}`, label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
        td.appendChild(b);
      };
      const id = r.orderItemId;
      add("ome-assign", "Person", "Assign person to this line", () => void this.assign(id));
      add("ome-link", "Link", "Link this line under another line",
          () => this.startPending(id, "Link: click the PARENT line in the grid."));
      add("ome-alt", "Alteration", "Attach this alteration to its garment",
          () => this.startPending(id, "Alteration: click the GARMENT it belongs to."));
      add("ome-note", "Note", "Add or edit a note", () => void this.note(id));
    }
  }

  private startPending(child: string, hint: string): void {
    this.pending = child;
    this.ensurePanel();
    const h = this.doc.getElementById("ome-hint")!;
    h.replaceChildren(this.doc.createTextNode(`${hint} `));
    const cancel = this.el("button", "ome-cancel", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", (e) => { e.stopPropagation(); this.cancelPending(); });
    h.appendChild(cancel);
    h.hidden = false;
    for (const r of this.rows) r.el.classList.toggle("ome-linkmode", r.orderItemId === child);
  }

  cancelPending(): void {
    this.pending = null;
    const h = this.doc.getElementById("ome-hint");
    if (h) { h.hidden = true; h.replaceChildren(); }
    this.doc.querySelectorAll(".ome-linkmode").forEach((r) => r.classList.remove("ome-linkmode"));
  }

  /** A row click while linking picks the parent. */
  private completeLink(ev: MouseEvent): void {
    if (!this.pending) return;
    const row = this.rows.find((r) => r.el.contains(ev.target as Node));
    if (!row) return;
    const child = this.pending;
    this.cancelPending();
    if (row.orderItemId === child) {
      this.setBanner({ kind: "error", text: "A line cannot be its own parent." });
      return;
    }
    void this.write(child, "link", { parent_order_item_id: row.orderItemId });
  }

  private async assign(id: string): Promise<void> {
    // Read the quantity now: staff may have changed it since the lines were detected.
    const row = this.rows.find((r) => r.orderItemId === id);
    const qty = row ? rowQuantity(row.el) : 1;
    if (qty > 1 && !this.dialogs.confirm(QTY_WARNING(qty))) return;
    const current = this.links.find((l) => l.order_item_id === id)?.wearer ?? "";
    const name = this.dialogs.prompt("Wearer for this line:", current)?.trim();
    if (name) await this.write(id, "assign", { wearer: name });
  }

  private async note(id: string): Promise<void> {
    const current = this.links.find((l) => l.order_item_id === id)?.note ?? "";
    const note = this.dialogs.prompt("Note for this line (empty to clear):", current);
    if (note !== null) await this.write(id, "note", { note: note.trim() });
  }

  // ------------------------------------------------------------- backend

  apply(s: OrderState): void {
    this.version = s.version;
    this.completed = s.completed;
    this.links = s.links ?? [];
    this.render();
  }

  private lines(): string[] {
    return this.rows.map((r) => r.orderItemId);
  }

  private async write(item: string, action: "assign" | "link" | "note", fields: Record<string, unknown>,
                      override = false): Promise<void> {
    if (!this.orderId) return;
    const path = `/api/orders/${encodeURIComponent(this.orderId)}/items/${encodeURIComponent(item)}/${action}`;
    const body = { ...fields, version: this.version, lines: this.lines(), ...(override ? { override: true } : {}) };
    const out: Outcome = await this.bridge.send({ type: "write", orderId: this.orderId, path, body });
    switch (out.kind) {
      case "ok":
        this.setBanner(null);
        this.apply(out.data);
        break;
      case "conflict":
        this.apply(out.current);
        this.setBanner({ kind: "error", text: "Sync conflict: someone else changed this order. Showing latest." });
        break;
      case "locked":
        this.apply(out.current);
        this.setBanner({ kind: "lock", text: "Order is completed: wearer, links and notes are locked." });
        if (this.dialogs.confirm("This order is completed. Override the lock for this change?\nThe override is recorded in the audit trail.")) {
          await this.write(item, action, fields, true);
        }
        break;
      case "queued":
        this.queue = { ...this.queue, waiting: out.waiting };
        this.setBanner(null);
        break;
      case "signin":
        this.setBanner({ kind: "signin", text: "Session expired: sign in to save. Your change was not saved. ",
                         action: { label: "Sign in", run: () => void this.bridge.send({ type: "openOptions" }) } });
        break;
      default:
        this.setBanner({ kind: "error", text: "message" in out ? out.message : "Request failed" });
    }
  }

  /** Rehydrate from the visible lines; then lock the order if RE says it is completed. */
  async refresh(statusCompleted: boolean): Promise<void> {
    if (!this.orderId) return;
    const out: Outcome = await this.bridge.send({ type: "lookup", orderId: this.orderId, lines: this.lines() });
    if (out.kind === "signin") {
      this.queue = { ...this.queue, signedIn: false };
      this.render();
      return;
    }
    if (out.kind === "offline") {
      this.setBanner({ kind: "offline", text: "Backend unreachable: showing nothing stored yet. ",
                       action: { label: "Retry", run: () => void this.refresh(statusCompleted) } });
      return;
    }
    if (out.kind !== "ok") return;
    this.apply(out.data);
    const orphans = this.links.filter((l) => l.orphaned).length;
    const foreign = out.data.foreign_lines?.length ?? 0;
    if (orphans) this.setBanner({ kind: "warn", text: `${orphans} link(s) reference lines no longer in this order (kept, not deleted).` });
    else if (foreign) this.setBanner({ kind: "warn", text: `${foreign} line(s) here are stored under a different order (not merged).` });
    else if (this.banner?.kind === "warn" || this.banner?.kind === "offline") this.setBanner(null);
    if (statusCompleted && !this.completed) {
      const done: Outcome = await this.bridge.send({ type: "complete", orderId: this.orderId, lines: this.lines() });
      if (done.kind === "ok") this.apply(done.data);
    }
  }

  setQueue(status: QueueStatus): void {
    const wasWaiting = this.queue.waiting;
    this.queue = status;
    this.renderBanners();
    // Queue drained or a replay hit a conflict: show what is stored now.
    if ((wasWaiting && !status.waiting) || status.blocked.some((b) => b.orderId === this.orderId)) {
      const b = status.blocked.find((x) => x.orderId === this.orderId);
      if (b) this.apply(b.current);
      else void this.refresh(false);
    }
  }

  private async retry(): Promise<void> {
    this.setQueue(await this.bridge.send({ type: "retry" }));
  }

  private async discard(): Promise<void> {
    if (!this.orderId) return;
    this.setQueue(await this.bridge.send({ type: "discard", orderId: this.orderId }));
    await this.refresh(false);
  }
}

/**
 * Sidecar data access: every read and write of sidecar data goes through here.
 *
 * Identity: a line is keyed by its OrderItemId alone (a GUID unique across
 * Retail Express). Lines, wearers, version and audit are grouped under a
 * sidecar order (`order_ref`); every RE order identifier seen for it - live
 * session GUID, order number after completion - is an alias.
 *
 * Only the extra layer lives here: wearers, links, notes, staff, audit.
 * No RE commercial data and no status (future phase).
 */
import type { Db, Queryable } from "./db/types.js";

export const NOTE_MAX = 1000;

export class StaleVersion extends Error {}
export class Locked extends Error {}
export class InvalidInput extends Error {}

export interface Link {
  order_item_id: string;
  wearer: string | null;
  wearer_id: number | null;
  parent_order_item_id: string | null;
  note: string | null;
  orphaned: boolean;
}

export interface OrderState {
  order_id: string;
  order_ref: number | null;
  version: number;
  completed: boolean;
  aliases: string[];
  links: Link[];
}

export interface LookupState extends OrderState {
  foreign_lines: string[];
}

export interface AuditEntry {
  order_item_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  staff: string;
  at: string;
}

type Column = "wearer_id" | "parent_order_item_id" | "note";

// column -> audit field name
const FIELDS: Record<Column, string> = {
  wearer_id: "wearer",
  parent_order_item_id: "parent",
  note: "note",
};

export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export class Repo {
  private t: Record<"staff" | "orders" | "aliases" | "wearers" | "links" | "audit", string>;

  constructor(private db: Db, schema: string) {
    this.t = {
      staff: `${schema}.staff`,
      orders: `${schema}.orders`,
      aliases: `${schema}.order_aliases`,
      wearers: `${schema}.wearers`,
      links: `${schema}.order_links`,
      audit: `${schema}.link_audit`,
    };
  }

  // ------------------------------------------------------------ identity

  private async aliasRef(q: Queryable, alias: string): Promise<number | null> {
    const r = await q.query<{ order_ref: number }>(
      `SELECT order_ref FROM ${this.t.aliases} WHERE alias = $1`, [alias]);
    return r.rows[0]?.order_ref ?? null;
  }

  private async lineRef(q: Queryable, item: string): Promise<number | null> {
    const r = await q.query<{ order_ref: number }>(
      `SELECT order_ref FROM ${this.t.links} WHERE order_item_id = $1`, [item]);
    return r.rows[0]?.order_ref ?? null;
  }

  /** Stored orders holding the given lines, most lines first (ties: oldest order). */
  private async lineCounts(q: Queryable, lines: string[]): Promise<{ order_ref: number; n: number }[]> {
    if (!lines.length) return [];
    const r = await q.query<{ order_ref: number; n: number }>(
      `SELECT order_ref, COUNT(*)::int AS n FROM ${this.t.links}
        WHERE order_item_id = ANY($1::text[]) GROUP BY order_ref ORDER BY n DESC, order_ref ASC`,
      [lines]);
    return r.rows;
  }

  private async newOrder(q: Queryable, alias: string): Promise<number> {
    const r = await q.query<{ order_ref: number }>(
      `INSERT INTO ${this.t.orders} DEFAULT VALUES RETURNING order_ref`);
    const ref = r.rows[0].order_ref;
    await this.recordAlias(q, alias, ref);
    return ref;
  }

  /** Free alias -> this order. An alias already owned by another order stays put. */
  private async recordAlias(q: Queryable, alias: string, ref: number): Promise<void> {
    if (!alias) return;
    await q.query(
      `INSERT INTO ${this.t.aliases} (alias, order_ref) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING`,
      [alias, ref]);
  }

  /**
   * Line's existing order wins, then the named alias, then the stored order
   * holding most of the visible lines, then a new order. A write is an explicit
   * staff action, so this is where an unseen identifier becomes an alias.
   */
  private async resolveForWrite(q: Queryable, orderId: string, item: string, lines?: string[]): Promise<number> {
    let ref = (await this.lineRef(q, item)) ?? (await this.aliasRef(q, orderId));
    if (ref === null) {
      const counts = await this.lineCounts(q, (lines ?? []).filter((x) => x && x !== item));
      ref = counts[0]?.order_ref ?? (await this.newOrder(q, orderId));
    }
    await this.recordAlias(q, orderId, ref);
    return ref;
  }

  // ---------------------------------------------------------------- reads

  private empty(orderId: string): OrderState {
    return { order_id: orderId, order_ref: null, version: 0, completed: false, aliases: [], links: [] };
  }

  async stateForRef(q: Queryable, ref: number, orderId: string, currentLines?: string[]): Promise<OrderState> {
    const order = (await q.query<{ version: number; completed_at: unknown }>(
      `SELECT version, completed_at FROM ${this.t.orders} WHERE order_ref = $1`, [ref])).rows[0];
    const rows = (await q.query<Omit<Link, "orphaned">>(
      `SELECT l.order_item_id, l.wearer_id, w.name AS wearer, l.parent_order_item_id, l.note
         FROM ${this.t.links} l LEFT JOIN ${this.t.wearers} w ON w.wearer_id = l.wearer_id
        WHERE l.order_ref = $1 ORDER BY l.order_item_id`, [ref])).rows;
    const aliases = (await q.query<{ alias: string }>(
      `SELECT alias FROM ${this.t.aliases} WHERE order_ref = $1 ORDER BY first_seen, alias`, [ref])).rows;
    return {
      order_id: orderId,
      order_ref: ref,
      version: order.version,
      completed: order.completed_at !== null,
      aliases: aliases.map((a) => a.alias),
      links: rows.map((r) => ({
        order_item_id: r.order_item_id,
        wearer: r.wearer,
        wearer_id: r.wearer_id,
        parent_order_item_id: r.parent_order_item_id,
        note: r.note,
        orphaned: currentLines !== undefined && !currentLines.includes(r.order_item_id),
      })),
    };
  }

  /** Read by any alias. Unknown alias -> empty structure. */
  async getState(orderId: string, currentLines?: string[]): Promise<OrderState> {
    const ref = await this.aliasRef(this.db, orderId);
    return ref === null ? this.empty(orderId) : this.stateForRef(this.db, ref, orderId, currentLines);
  }

  /** State of the order a line belongs to, else by alias (for 409/423 `current`). */
  async currentFor(orderId: string, item?: string): Promise<OrderState> {
    const ref = item ? await this.lineRef(this.db, item) : null;
    return ref === null ? this.getState(orderId) : this.stateForRef(this.db, ref, orderId);
  }

  /**
   * Find the order the visible lines belong to. Read-only: never records an
   * alias - the page can briefly show a new order id next to the previous
   * order's rows (starting a new sale), and registering it here merged the
   * new sale into the old order. Aliases come from writes and completion only.
   */
  async lookup(orderId: string, lines: string[]): Promise<LookupState> {
    const clean = lines.filter(Boolean);
    const counts = await this.lineCounts(this.db, clean);
    if (!counts.length) {
      const ref = await this.aliasRef(this.db, orderId);
      if (ref === null) return { ...this.empty(orderId), foreign_lines: [] };
      return { ...(await this.stateForRef(this.db, ref, orderId, clean)), foreign_lines: [] };
    }
    const ref = counts[0].order_ref;
    const foreign = (await this.db.query<{ order_item_id: string }>(
      `SELECT order_item_id FROM ${this.t.links}
        WHERE order_item_id = ANY($1::text[]) AND order_ref <> $2 ORDER BY order_item_id`,
      [clean, ref])).rows.map((r) => r.order_item_id);
    return { ...(await this.stateForRef(this.db, ref, orderId, clean)), foreign_lines: foreign };
  }

  async listAudit(orderId: string): Promise<AuditEntry[]> {
    const ref = await this.aliasRef(this.db, orderId);
    if (ref === null) return [];
    return (await this.db.query<AuditEntry>(
      `SELECT a.order_item_id, a.field, a.old_value, a.new_value, s.username AS staff, a.at
         FROM ${this.t.audit} a JOIN ${this.t.staff} s ON s.staff_id = a.staff_id
        WHERE a.order_ref = $1 ORDER BY a.audit_id`, [ref])).rows;
  }

  // --------------------------------------------------------------- writes

  private async upsertWearer(q: Queryable, ref: number, name: string): Promise<number> {
    const clean = name.trim();
    if (!clean) throw new InvalidInput("wearer is required");
    await q.query(
      `INSERT INTO ${this.t.wearers} (order_ref, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (order_ref, name_key) DO NOTHING`, [ref, clean, nameKey(clean)]);
    return (await q.query<{ wearer_id: number }>(
      `SELECT wearer_id FROM ${this.t.wearers} WHERE order_ref = $1 AND name_key = $2`,
      [ref, nameKey(clean)])).rows[0].wearer_id;
  }

  private async audit(q: Queryable, ref: number, item: string, field: string,
                      oldV: string | null, newV: string | null, staffId: number): Promise<void> {
    await q.query(
      `INSERT INTO ${this.t.audit} (order_ref, order_item_id, field, old_value, new_value, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6)`, [ref, item, field, oldV, newV, staffId]);
  }

  /**
   * Write one field of one line; audit only when the value actually changes.
   * Every field is locked on a completed order unless `override` (audited).
   */
  private async apply(q: Queryable, ref: number, completed: boolean, item: string, column: Column,
                      value: string | number | null, staffId: number, override: boolean): Promise<void> {
    const cur = (await q.query<{ wearer_id: number | null; wearer: string | null;
                                parent_order_item_id: string | null; note: string | null }>(
      `SELECT l.wearer_id, w.name AS wearer, l.parent_order_item_id, l.note
         FROM ${this.t.links} l LEFT JOIN ${this.t.wearers} w ON w.wearer_id = l.wearer_id
        WHERE l.order_item_id = $1`, [item])).rows[0];
    const old = cur ? cur[column] : null;
    if (cur && old === value) return;
    const changing = old !== value;
    if (changing && completed) {
      if (!override) throw new Locked();
      await this.audit(q, ref, item, "override", null, FIELDS[column], staffId);
    }
    await q.query(
      `INSERT INTO ${this.t.links} (order_item_id, order_ref, ${column}, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (order_item_id) DO UPDATE SET ${column} = EXCLUDED.${column},
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [item, ref, value, staffId]);
    if (!changing) return; // new row holding an empty value: nothing worth auditing
    let oldLabel = old === null ? null : String(old);
    let newLabel = value === null ? null : String(value);
    if (column === "wearer_id") {
      oldLabel = cur?.wearer ?? null;
      newLabel = value === null ? null : (await q.query<{ name: string }>(
        `SELECT name FROM ${this.t.wearers} WHERE wearer_id = $1`, [value])).rows[0].name;
    }
    await this.audit(q, ref, item, FIELDS[column], oldLabel, newLabel, staffId);
  }

  /** Same-order and no-cycle rules for `item.parent = parent` (order-line-links spec). */
  private async checkParent(q: Queryable, ref: number, item: string, parent: string): Promise<void> {
    if (parent === item) throw new InvalidInput("a line cannot be its own parent");
    const parentRef = await this.lineRef(q, parent);
    if (parentRef !== null && parentRef !== ref) {
      throw new InvalidInput("parent line belongs to a different order");
    }
    // Walk the parent's ancestors; finding the child there means a cycle.
    const cycle = await q.query(
      `WITH RECURSIVE anc(id) AS (
         SELECT $1::text
         UNION
         SELECT l.parent_order_item_id FROM ${this.t.links} l JOIN anc ON l.order_item_id = anc.id
          WHERE l.parent_order_item_id IS NOT NULL)
       SELECT 1 FROM anc WHERE id = $2`, [parent, item]);
    if (cycle.rows.length) throw new InvalidInput("link would create a cycle");
  }

  /** One transaction: resolve order, lock its row, check version, apply, bump. */
  private async write(orderId: string, item: string, expected: number | undefined, lines: string[] | undefined,
                      fn: (q: Queryable, ref: number, completed: boolean) => Promise<void>): Promise<number> {
    return this.db.transaction(async (q) => {
      const ref = await this.resolveForWrite(q, orderId, item, lines);
      const order = (await q.query<{ version: number; completed_at: unknown }>(
        `SELECT version, completed_at FROM ${this.t.orders} WHERE order_ref = $1 FOR UPDATE`, [ref])).rows[0];
      if (expected !== undefined && expected !== order.version) throw new StaleVersion();
      await fn(q, ref, order.completed_at !== null);
      await q.query(`UPDATE ${this.t.orders} SET version = version + 1 WHERE order_ref = $1`, [ref]);
      return ref;
    });
  }

  async setWearer(orderId: string, item: string, wearer: string, staffId: number,
                  opts: WriteOpts = {}): Promise<number> {
    if (!wearer?.trim()) throw new InvalidInput("wearer is required");
    return this.write(orderId, item, opts.version, opts.lines, async (q, ref, completed) =>
      this.apply(q, ref, completed, item, "wearer_id", await this.upsertWearer(q, ref, wearer),
                 staffId, !!opts.override));
  }

  async setParent(orderId: string, item: string, parent: string, staffId: number,
                  opts: WriteOpts = {}): Promise<number> {
    if (!parent) throw new InvalidInput("parent_order_item_id is required");
    if (parent === item) throw new InvalidInput("a line cannot be its own parent");
    // The parent itself is visible context: a new alteration joins its garment's order.
    return this.write(orderId, item, opts.version, opts.lines ?? [parent], async (q, ref, completed) => {
      await this.checkParent(q, ref, item, parent);
      await this.apply(q, ref, completed, item, "parent_order_item_id", parent, staffId, !!opts.override);
    });
  }

  async setNote(orderId: string, item: string, note: string | null | undefined, staffId: number,
                opts: WriteOpts = {}): Promise<number> {
    const text = (note ?? "").trim();
    if (text.length > NOTE_MAX) throw new InvalidInput(`note longer than ${NOTE_MAX} characters`);
    return this.write(orderId, item, opts.version, opts.lines, (q, ref, completed) =>
      this.apply(q, ref, completed, item, "note", text || null, staffId, !!opts.override));
  }

  /** Mark completed (idempotent). Visible lines win over the shown id, as in lookup. */
  async completeOrder(orderId: string, lines: string[] = []): Promise<number> {
    return this.db.transaction(async (q) => {
      const counts = await this.lineCounts(q, lines.filter(Boolean));
      const ref = counts[0]?.order_ref ?? (await this.aliasRef(q, orderId)) ?? (await this.newOrder(q, orderId));
      await this.recordAlias(q, orderId, ref);
      await q.query(
        `UPDATE ${this.t.orders} SET completed_at = COALESCE(completed_at, now()) WHERE order_ref = $1`, [ref]);
      return ref;
    });
  }

  /** Replace wearer/parent (and note when given) for each listed line. */
  async bulkPut(orderId: string, links: BulkLink[], staffId: number, version: number,
                override = false): Promise<number> {
    const items = links.map((l) => (l.order_item_id ?? "").trim());
    const first = items.find(Boolean) ?? "";
    return this.write(orderId, first, version, items, async (q, ref, completed) => {
      for (const [i, link] of links.entries()) {
        const item = items[i];
        if (!item) continue;
        const owner = await this.lineRef(q, item);
        if (owner !== null && owner !== ref) throw new InvalidInput(`line ${item} belongs to a different order`);
        const parent = link.parent_order_item_id || null;
        if (parent) await this.checkParent(q, ref, item, parent);
        const wearer = (link.wearer ?? "").trim();
        await this.apply(q, ref, completed, item, "wearer_id",
                         wearer ? await this.upsertWearer(q, ref, wearer) : null, staffId, override);
        await this.apply(q, ref, completed, item, "parent_order_item_id", parent, staffId, override);
        if ("note" in link) {
          const note = (link.note ?? "").trim();
          if (note.length > NOTE_MAX) throw new InvalidInput(`note longer than ${NOTE_MAX} characters`);
          await this.apply(q, ref, completed, item, "note", note || null, staffId, override);
        }
      }
    });
  }

  async stateAfterWrite(ref: number, orderId: string): Promise<OrderState> {
    return this.stateForRef(this.db, ref, orderId);
  }
}

export interface WriteOpts {
  version?: number;
  override?: boolean;
  lines?: string[];
}

export interface BulkLink {
  order_item_id?: string;
  wearer?: string | null;
  parent_order_item_id?: string | null;
  note?: string | null;
}

/**
 * Repo rules: ports of the order-identity, order-line-links, sidecar-storage
 * and order-guards spec scenarios, plus the new no-cycle / same-order rules.
 */
import { randomUUID as guid } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidInput, Locked, Repo, StaleVersion } from "../src/repo.js";
import { SCHEMAS, useTestDb } from "./helpers.js";

const t = useTestDb();
let repo: Repo;
let demo: number;
let anna: number;

async function addStaff(username: string): Promise<number> {
  const r = await t.db().query<{ staff_id: number }>(
    "INSERT INTO sidecar.staff (username, password_hash) VALUES ($1, 'x') RETURNING staff_id", [username]);
  return r.rows[0].staff_id;
}

beforeEach(async () => {
  repo = new Repo(t.db(), SCHEMAS.sidecar);
  demo = await addStaff("demo");
  anna = await addStaff("anna");
});

const links = async (orderId: string) =>
  Object.fromEntries((await repo.getState(orderId)).links.map((l) => [l.order_item_id, l]));

// ------------------------------------------------------------ order-identity

describe("order identity", () => {
  it("two identifiers resolve to one order", async () => {
    const [g, n, l1] = [guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.setNote(n, l1, "x", demo); // write under n records the alias
    const a = await repo.getState(g);
    const b = await repo.getState(n);
    expect([a.order_ref, a.version, a.links]).toEqual([b.order_ref, b.version, b.links]);
  });

  it("wearer reuse spans aliases", async () => {
    const [g, n, l1, l2] = [guid(), guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.setWearer(n, l2, "james", demo, { lines: [l1, l2] });
    const ls = (await repo.getState(g)).links;
    expect(ls).toHaveLength(2);
    expect(new Set(ls.map((l) => l.wearer_id)).size).toBe(1);
  });

  it("lookup finds the order without registering the identifier", async () => {
    const [g, n, l1, l2, l3] = [guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.setParent(g, l3, l1, demo);
    const before = await repo.getState(g);
    const after = await repo.lookup(n, [l1, l2, l3]);
    expect(after.order_ref).toBe(before.order_ref);
    expect(after.version).toBe(before.version);
    expect(after.aliases).toEqual([g]);
    expect(after.foreign_lines).toEqual([]);
    expect((await repo.getState(n)).order_ref).toBeNull();
  });

  it("new sale next to stale lines is not merged", async () => {
    const [g, s, l1, l2, l5] = [guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.setWearer(g, l2, "James", demo);
    const before = await repo.getState(g);
    await repo.lookup(s, [l1, l2]);
    await repo.setWearer(s, l5, "Peter", demo, { lines: [l5] });
    const fresh = await repo.getState(s);
    expect(fresh.order_ref).not.toBe(before.order_ref);
    expect(fresh.aliases).toEqual([s]);
    expect(fresh.links.map((l) => l.order_item_id)).toEqual([l5]);
    expect(await repo.getState(g)).toEqual(before);
  });

  it("never-stored lines create nothing", async () => {
    const n = guid();
    const st = await repo.lookup(n, [guid(), guid()]);
    expect([st.links, st.version, st.aliases, st.order_ref]).toEqual([[], 0, [], null]);
    expect((await repo.getState(n)).order_ref).toBeNull();
  });

  it("lines from two orders are not merged; majority wins", async () => {
    const [a, b, n, l1, l2, l9] = [guid(), guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(a, l1, "James", demo);
    await repo.setWearer(a, l2, "James", demo);
    await repo.setWearer(b, l9, "Peter", demo);
    const st = await repo.lookup(n, [l1, l2, l9]);
    expect(st.order_ref).toBe((await repo.getState(a)).order_ref);
    expect(st.foreign_lines).toEqual([l9]);
    expect((await links(b))[l9].wearer).toBe("Peter");
  });

  it("tie goes to the oldest order", async () => {
    const [a, b, n, la, lb] = [guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(a, la, "James", demo);
    await repo.setWearer(b, lb, "Peter", demo);
    const st = await repo.lookup(n, [lb, la]);
    expect(st.order_ref).toBe((await repo.getState(a)).order_ref);
    expect(st.foreign_lines).toEqual([lb]);
  });

  it("write under a new identifier joins the existing order", async () => {
    const [g, n, l1] = [guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    const before = await repo.getState(g);
    await repo.setWearer(n, l1, "Michael", demo);
    const after = await repo.getState(g);
    expect(after.order_ref).toBe(before.order_ref);
    expect(after.version).toBe(before.version + 1);
    expect(after.links[0].wearer).toBe("Michael");
    expect(after.aliases).toContain(n);
    const { rows } = await t.db().query("SELECT 1 FROM sidecar.orders");
    expect(rows).toHaveLength(1);
  });

  it("new line on a reopened order joins it", async () => {
    const [g, n, l1, l2, l4] = [guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.setWearer(g, l2, "James", demo);
    const ref = (await repo.getState(g)).order_ref;
    expect(await repo.setWearer(n, l4, "Gary", demo, { lines: [l1, l2, l4] })).toBe(ref);
    expect((await repo.getState(n)).links).toHaveLength(3);
  });

  it("alteration link joins its garment's order", async () => {
    const [g, n, garment, alt] = [guid(), guid(), guid(), guid()];
    await repo.setWearer(g, garment, "James", demo);
    expect(await repo.setParent(n, alt, garment, demo)).toBe((await repo.getState(g)).order_ref);
  });

  it("line keeps its links when the order identifier changes", async () => {
    const [g, n, l1] = [guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    expect((await repo.lookup(n, [l1])).links[0].wearer).toBe("James");
    await repo.completeOrder(n, [l1]);
    expect((await links(n))[l1].wearer).toBe("James");
  });
});

// ---------------------------------------------------------- order-line-links

describe("order line links", () => {
  it("assign, reassign (history only in audit), duplicate products independent", async () => {
    const [o, l1, l2] = [guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await repo.setWearer(o, l1, "Michael", demo);
    const st = await links(o);
    expect(st[l1].wearer).toBe("Michael");
    expect(st[l2]).toBeUndefined();
    const audit = (await repo.listAudit(o)).filter((a) => a.field === "wearer");
    expect(audit.map((a) => [a.old_value, a.new_value])).toEqual([[null, "James"], ["James", "Michael"]]);
  });

  it("links an alteration to its garment; reopen restores structure", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await repo.setParent(o, l3, l1, demo);
    const st = await repo.getState(o);
    expect(st.version).toBe(2);
    expect(st.links.map((l) => [l.order_item_id, l.wearer, l.parent_order_item_id]).sort())
      .toEqual([[l1, "James", null], [l3, null, l1]].sort());
  });

  it("unknown order returns an empty structure", async () => {
    const st = await repo.getState(guid());
    expect([st.links, st.version]).toEqual([[], 0]);
  });

  it("orphaned links are flagged, never deleted", async () => {
    const [o, l1, l9] = [guid(), guid(), guid()];
    await repo.setWearer(o, l9, "Peter", demo);
    await repo.setWearer(o, l1, "James", demo);
    const st = await repo.getState(o, [l1]);
    expect(st.links.filter((l) => l.orphaned).map((l) => l.order_item_id)).toEqual([l9]);
    expect((await links(o))[l9]).toMatchObject({ wearer: "Peter", orphaned: false });
  });

  it("stale version is rejected and nothing lands", async () => {
    const [o, l1, lx] = [guid(), guid(), guid()];
    await repo.setWearer(o, l1, "Michael", demo);
    await expect(repo.setWearer(o, lx, "Ghost", demo, { version: 0 })).rejects.toBeInstanceOf(StaleVersion);
    await expect(repo.bulkPut(o, [{ order_item_id: lx, wearer: "Ghost" }], demo, 0))
      .rejects.toBeInstanceOf(StaleVersion);
    expect((await links(o))[lx]).toBeUndefined();
  });
});

// --------------------------------------------- new rules: no cycles, same order

describe("parent rules", () => {
  const rejected = async (p: Promise<unknown>, o: string) => {
    const before = await repo.getState(o);
    await expect(p).rejects.toBeInstanceOf(InvalidInput);
    expect(await repo.getState(o)).toEqual(before);
  };

  it("rejects a line as its own parent", async () => {
    const [o, l1] = [guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await rejected(repo.setParent(o, l1, l1, demo), o);
  });

  it("rejects a 2-step cycle", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await repo.setParent(o, l3, l1, demo);
    await repo.setWearer(o, l1, "James", demo);
    await rejected(repo.setParent(o, l1, l3, demo), o);
  });

  it("rejects a 3-step cycle", async () => {
    const [o, l1, l2, l3] = [guid(), guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await repo.setParent(o, l2, l1, demo);
    await repo.setParent(o, l3, l2, demo);
    await rejected(repo.setParent(o, l1, l3, demo), o);
    await rejected(repo.bulkPut(o, [{ order_item_id: l1, parent_order_item_id: l3 }], demo,
                                (await repo.getState(o)).version), o);
  });

  it("rejects a parent from another order", async () => {
    const [a, b, l1, l9] = [guid(), guid(), guid(), guid()];
    await repo.setWearer(a, l1, "James", demo);
    await repo.setWearer(b, l9, "Peter", demo);
    const beforeA = await repo.getState(a);
    await rejected(repo.setParent(b, l9, l1, demo), b);
    expect(await repo.getState(a)).toEqual(beforeA);
  });

  it("allows a parent that is not stored yet", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await repo.setParent(o, l3, l1, demo);
    expect((await links(o))[l3].parent_order_item_id).toBe(l1);
  });
});

// ----------------------------------------------- wearers, audit, notes, lock

describe("wearers and audit", () => {
  it("same name reuses the wearer; other order gets another", async () => {
    const [o, o2, l1, l2, l3] = [guid(), guid(), guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await repo.setWearer(o, l2, " james ", demo);
    const st = await links(o);
    expect(st[l1].wearer_id).toBe(st[l2].wearer_id);
    expect(st[l2].wearer).toBe("James");
    await repo.setWearer(o2, l3, "James", demo);
    expect((await links(o2))[l3].wearer_id).not.toBe(st[l1].wearer_id);
  });

  it("records staff, skips unchanged values, lists oldest first", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", anna);
    await repo.setWearer(o, l1, "JAMES", anna);
    await repo.setParent(o, l3, l1, demo);
    await repo.setNote(o, l3, "Hem 2cm", demo);
    const audit = await repo.listAudit(o);
    expect(audit.map((a) => [a.field, a.staff])).toEqual([["wearer", "anna"], ["parent", "demo"], ["note", "demo"]]);
  });
});

describe("notes", () => {
  it("adds, clears (old value audited) and rejects oversized", async () => {
    const [o, l3] = [guid(), guid()];
    await repo.setNote(o, l3, "Hem 2cm, collect Fri", demo);
    expect((await links(o))[l3].note).toBe("Hem 2cm, collect Fri");
    await repo.setNote(o, l3, "", demo);
    expect((await links(o))[l3].note).toBeNull();
    const last = (await repo.listAudit(o)).at(-1)!;
    expect([last.field, last.old_value, last.new_value]).toEqual(["note", "Hem 2cm, collect Fri", null]);
    await repo.setNote(o, l3, "keep", demo);
    await expect(repo.setNote(o, l3, "x".repeat(1001), demo)).rejects.toBeInstanceOf(InvalidInput);
    expect((await links(o))[l3].note).toBe("keep");
    await repo.setNote(o, l3, "y".repeat(1000), demo);
  });
});

describe("completed-order lock", () => {
  async function completed() {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await repo.setWearer(o, l1, "James", demo);
    await repo.setParent(o, l3, l1, demo);
    await repo.completeOrder(o);
    return { o, l1, l3 };
  }

  it("rejects wearer, parent and note changes without override", async () => {
    const { o, l1, l3 } = await completed();
    const before = await repo.getState(o);
    await expect(repo.setWearer(o, l1, "Michael", demo)).rejects.toBeInstanceOf(Locked);
    await expect(repo.setParent(o, l3, guid(), demo)).rejects.toBeInstanceOf(Locked);
    await expect(repo.setNote(o, l1, "x", demo)).rejects.toBeInstanceOf(Locked);
    expect(await repo.getState(o)).toEqual(before);
    expect(before.completed).toBe(true);
  });

  it("applies and audits an override", async () => {
    const { o, l1 } = await completed();
    await repo.setWearer(o, l1, "Michael", anna, { override: true });
    expect((await links(o))[l1].wearer).toBe("Michael");
    const tail = (await repo.listAudit(o)).slice(-2);
    expect(tail.map((e) => [e.field, e.new_value, e.staff])).toEqual([
      ["override", "wearer", "anna"], ["wearer", "Michael", "anna"]]);
  });

  it("complete is idempotent and resolves by lines under an unseen number", async () => {
    const [g, n, l1] = [guid(), guid(), guid()];
    await repo.setWearer(g, l1, "James", demo);
    await repo.completeOrder(n, [l1]);
    await repo.completeOrder(n, [l1]);
    const st = await repo.getState(g);
    expect(st.completed).toBe(true);
    expect(st.aliases).toContain(n);
    await expect(repo.setWearer(g, l1, "X", demo)).rejects.toBeInstanceOf(Locked);
  });
});

// ------------------------------------------------------------- footprint

describe("data footprint", () => {
  it("stores no RE commercial data and no status", async () => {
    const { rows } = await t.db().query<{ c: string }>(
      "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'sidecar'");
    const cols = rows.map((r) => r.c.toLowerCase());
    const forbidden = ["price", "sku", "plu", "product", "stock", "payment", "customer", "description", "status"];
    expect(cols.filter((c) => forbidden.some((f) => c.includes(f)))).toEqual([]);
  });
});

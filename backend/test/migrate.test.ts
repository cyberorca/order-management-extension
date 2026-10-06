import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { pgliteDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/types.js";

let db: Db;
afterEach(async () => db?.close());

describe("migrations", () => {
  it("creates both schemas and is a no-op the second time", async () => {
    db = pgliteDb();
    const first = await migrate(db, { sidecar: "sidecar", mock: "mock" });
    expect(first).toEqual(["001_sidecar.sql", "002_mock.sql"]);
    expect(await migrate(db, { sidecar: "sidecar", mock: "mock" })).toEqual([]);
    const { rows } = await db.query<{ t: string }>(
      "SELECT table_schema || '.' || table_name AS t FROM information_schema.tables" +
        " WHERE table_schema IN ('sidecar','mock') ORDER BY 1",
    );
    expect(rows.map((r) => r.t)).toEqual([
      "mock.rex_order_items", "mock.rex_orders",
      "sidecar.health_reports", "sidecar.link_audit", "sidecar.order_aliases",
      "sidecar.order_links", "sidecar.orders", "sidecar.staff", "sidecar.wearers",
    ]);
  });

  it("uses configurable schema names", async () => {
    db = pgliteDb();
    await migrate(db, { sidecar: "s2", mock: "m2" });
    const { rows } = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 's2'");
    expect(rows.length).toBe(7);
  });

  it("rejects unsafe schema names", async () => {
    db = pgliteDb();
    await expect(migrate(db, { sidecar: "x; drop", mock: "m" })).rejects.toThrow(/invalid schema/);
  });
});

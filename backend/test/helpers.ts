import { afterAll, beforeAll, beforeEach } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { pgliteDb } from "../src/db/pglite.js";
import type { Db, Schemas } from "../src/db/types.js";

export const SCHEMAS: Schemas = { sidecar: "sidecar", mock: "mock" };

/** One migrated PGlite per test file; every table emptied before each test. */
export function useTestDb(): { db: () => Db } {
  let db: Db;
  beforeAll(async () => {
    db = pgliteDb();
    await migrate(db, SCHEMAS);
  });
  beforeEach(async () => {
    await db.exec(
      "TRUNCATE sidecar.link_audit, sidecar.order_links, sidecar.wearers, sidecar.order_aliases," +
        " sidecar.orders, sidecar.staff, sidecar.health_reports, mock.rex_order_items, mock.rex_orders" +
        " RESTART IDENTITY CASCADE",
    );
  });
  afterAll(async () => db?.close());
  return { db: () => db };
}

import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./types.js";

/** In-process Postgres for tests and local trials: same SQL dialect as Neon, no network.
 *  `dataDir` keeps the data on disk across restarts (e2e offline steps). */
export function pgliteDb(dataDir?: string): Db {
  const pg = new PGlite(dataDir);
  return {
    async query(sql, params) {
      const r = await pg.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as never[] };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction(fn) {
      return pg.transaction((tx) =>
        fn({
          async query(sql, params) {
            const r = await tx.query(sql, params as unknown[] | undefined);
            return { rows: r.rows as never[] };
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}

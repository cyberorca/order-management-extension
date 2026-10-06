import { Pool } from "@neondatabase/serverless";
import type { Db, Queryable } from "./types.js";

/** Neon serverless Pool (WebSocket): supports interactive transactions on Vercel. */
export function neonDb(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return {
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query(sql, params) {
            const r = await client.query(sql, params as unknown[] | undefined);
            return { rows: r.rows };
          },
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

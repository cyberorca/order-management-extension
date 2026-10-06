/**
 * Local server: `npm run dev -w backend` (reads backend/.env).
 * DATABASE_URL=pglite:memory (or pglite:<dir> to keep data on disk) runs an
 * in-process Postgres with migrations applied - for local trials and the e2e
 * suite only (never on Vercel).
 * SEED_STAFF=user:password[,user2:password2] creates those logins at start (dev only).
 */
import { buildApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { neonDb } from "./db/neon.js";
import { pgliteDb } from "./db/pglite.js";

const config = loadConfig();
const local = config.databaseUrl.startsWith("pglite:");
const dir = config.databaseUrl.slice("pglite:".length);
const db = local ? pgliteDb(dir === "memory" ? undefined : dir) : neonDb(config.databaseUrl);
if (local) await migrate(db, config.schemas);
for (const pair of (process.env.SEED_STAFF ?? "").split(",").filter(Boolean)) {
  const [username, password] = pair.split(":");
  await db.query(
    `INSERT INTO ${config.schemas.sidecar}.staff (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE`,
    [username, await hashPassword(password)]);
}
const app = buildApp(db, config, { logger: !process.env.QUIET });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 3000) });

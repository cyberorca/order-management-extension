/** Apply SQL migrations to DATABASE_URL: `npm run migrate -w backend`. */
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { neonDb } from "../src/db/neon.js";

const config = loadConfig();
const db = neonDb(config.databaseUrl);
const applied = await migrate(db, config.schemas);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date");
await db.close();

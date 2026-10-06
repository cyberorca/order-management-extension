/**
 * Create or reset a staff login: `npm run staff:add -w backend -- <username> [display name]`.
 * Prompts for the password (never pass it on the command line); stores only a bcrypt hash.
 */
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { neonDb } from "../src/db/neon.js";

const [username, ...name] = process.argv.slice(2);
if (!username) {
  console.error("usage: npm run staff:add -w backend -- <username> [display name]");
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = (await rl.question(`Password for ${username}: `)).trim();
rl.close();
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}
const config = loadConfig();
const db = neonDb(config.databaseUrl);
await db.query(
  `INSERT INTO ${config.schemas.sidecar}.staff (username, display_name, password_hash) VALUES ($1, $2, $3)
   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE`,
  [username, name.join(" ") || null, await hashPassword(password)]);
console.log(`Staff ${username} ready`);
await db.close();

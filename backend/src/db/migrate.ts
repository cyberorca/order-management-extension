import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db, Schemas } from "./types.js";

const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Apply migrations/NNN_*.sql in order. Files use {{sidecar}} / {{mock}} for the
 * configurable schema names; each (file, schemas) pair is recorded once.
 */
export async function migrate(db: Db, schemas: Schemas): Promise<string[]> {
  for (const s of [schemas.sidecar, schemas.mock]) {
    if (!IDENT.test(s)) throw new Error(`invalid schema name: ${s}`);
  }
  await db.exec(
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (" +
      " name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const files = (await readdir(DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const key = `${file}@${schemas.sidecar}/${schemas.mock}`;
    const done = await db.query("SELECT 1 FROM public.schema_migrations WHERE name = $1", [key]);
    if (done.rows.length) continue;
    const sql = (await readFile(DIR + file, "utf8"))
      .replaceAll("{{sidecar}}", schemas.sidecar)
      .replaceAll("{{mock}}", schemas.mock);
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO public.schema_migrations (name) VALUES ('${key}');\nCOMMIT;`);
    applied.push(file);
  }
  return applied;
}

/**
 * Vercel Function entry: every /api/*, /pos* and /rex/mock/* request is
 * rewritten here (vercel.json) and handed to the Fastify app.
 * Assumption to verify on the first preview deploy (task 7.1).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { neonDb } from "../src/db/neon.js";

const config = loadConfig();
const app = buildApp(neonDb(config.databaseUrl), config);
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready;
  app.server.emit("request", req, res);
}

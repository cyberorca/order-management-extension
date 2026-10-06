/** Backend process control + small HTTP helpers for the e2e suite. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PORT = 3999;
export const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(import.meta.dirname, "..");

export function buildExtension(): string {
  execFileSync("node", ["build.mjs"], { cwd: join(ROOT, "extension"), env: { ...process.env, BACKEND_URL: BASE } });
  return join(ROOT, "extension", "dist");
}

/** Backend on a file-backed PGlite so data survives stop/start (offline steps). */
export class Backend {
  private proc: ChildProcess | null = null;
  private dataDir = mkdtempSync(join(tmpdir(), "ome-e2e-db-"));

  async start(): Promise<void> {
    this.proc = spawn("npx", ["tsx", "src/server.ts"], {
      cwd: join(ROOT, "backend"),
      env: {
        ...process.env, PORT: String(PORT), QUIET: "1", ENABLE_MOCK: "true",
        DATABASE_URL: `pglite:${this.dataDir}`,
        SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
        SEED_STAFF: "demo:demo-password,ben:ben-password",
      },
      stdio: "inherit",
    });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("backend did not start");
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await exited;
    // npx -> tsx -> node: make sure the port is really free before continuing.
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${BASE}/api/health`); } catch { return; }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("backend still answering after stop");
  }
}

export async function token(username: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  return (await r.json()).token;
}

export async function api(tok: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

export async function mockOrder(products: number[]): Promise<{ guid: string; items: string[] }> {
  const post = (url: string, body: unknown = {}) => fetch(`${BASE}${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const guid = (await post("/rex/mock/pos/new-order")).orderId;
  const items: string[] = [];
  for (const pid of products) items.push((await post("/rex/mock/pos/add-item", { orderId: guid, items: [{ ProductId: pid }] })).OrderItemId);
  return { guid, items };
}

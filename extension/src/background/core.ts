/**
 * Service-worker core: backend client, session token, and the offline queue.
 * No chrome.* here - storage and fetch are injected so tests can fake them.
 *
 * Queue rules (order-guards "Never drop edits silently"):
 * - every write goes through the queue, so writes always reach the backend in
 *   the order staff made them;
 * - a network error stops the flush; the edit stays queued, never shown saved;
 * - a 409/423 stops that order's replay and keeps its remaining edits, so a
 *   newer change by someone else is never overwritten; other orders continue;
 * - edits queued back-to-back for one order were all based on the same
 *   version, so each replays on the version its predecessor produced.
 */
import type { HealthReport, OrderState, Outcome, QueueStatus } from "../shared/messages.js";

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Deps {
  backendUrl: string;
  fetch: typeof fetch;
  /** Cleared when the browser closes (chrome.storage.session). */
  session: KV;
  /** Survives service-worker restarts (chrome.storage.local). */
  local: KV;
}

export interface QueueEntry {
  id: string;
  orderId: string;
  path: string;
  body: Record<string, unknown>;
  baseVersion?: number;
  createdAt: number;
  blocked?: { kind: "conflict" | "locked"; current: OrderState };
}

const TOKEN = "token";
const QUEUE = "queue";

class Network extends Error {}

export class Core {
  private flushing: Promise<void> | null = null;
  private outcomes = new Map<string, Outcome>();

  constructor(private d: Deps) {}

  // ------------------------------------------------------------- session

  async signedIn(): Promise<boolean> {
    return !!(await this.d.session.get<string>(TOKEN));
  }

  async login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
    let r: Response;
    try {
      r = await this.d.fetch(`${this.d.backendUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      return { ok: false, error: "Backend unreachable" };
    }
    if (!r.ok) return { ok: false, error: r.status === 401 ? "Wrong username or password" : `Sign-in failed (${r.status})` };
    const data = (await r.json()) as { token: string };
    await this.d.session.set(TOKEN, data.token);
    void this.flush(); // edits queued while signed out can go now
    return { ok: true };
  }

  async logout(): Promise<void> {
    await this.d.session.remove(TOKEN);
  }

  // -------------------------------------------------------------- calls

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const token = await this.d.session.get<string>(TOKEN);
    if (!token) return { status: 401, data: null };
    let r: Response;
    try {
      r = await this.d.fetch(`${this.d.backendUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Network();
    }
    if (r.status === 401) await this.d.session.remove(TOKEN);
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  }

  private toOutcome(status: number, data: any): Outcome {
    if (status === 200) return { kind: "ok", data };
    if (status === 401) return { kind: "signin" };
    if (status === 409) return { kind: "conflict", current: data.current };
    if (status === 423) return { kind: "locked", current: data.current };
    return { kind: "error", message: data?.error ?? `Request failed (${status})` };
  }

  async lookup(orderId: string, lines: string[]): Promise<Outcome> {
    try {
      const r = await this.call("POST", "/api/orders/lookup", { order_id: orderId, lines });
      return this.toOutcome(r.status, r.data);
    } catch {
      return { kind: "offline" };
    }
  }

  async complete(orderId: string, lines: string[]): Promise<Outcome> {
    try {
      const r = await this.call("POST", `/api/orders/${encodeURIComponent(orderId)}/complete`, { lines });
      return this.toOutcome(r.status, r.data);
    } catch {
      return { kind: "offline" };
    }
  }

  /** Health reports need no session: the page can break before anyone signs in. */
  async health(report: HealthReport): Promise<void> {
    try {
      await this.d.fetch(`${this.d.backendUrl}/api/health-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
    } catch {
      /* best effort; the visible warning already told staff */
    }
  }

  // -------------------------------------------------------------- queue

  private async queue(): Promise<QueueEntry[]> {
    return (await this.d.local.get<QueueEntry[]>(QUEUE)) ?? [];
  }

  private async save(q: QueueEntry[]): Promise<void> {
    await this.d.local.set(QUEUE, q);
  }

  /** Queue the edit, try to send everything, and report what happened to this one. */
  async write(orderId: string, path: string, body: Record<string, unknown>): Promise<Outcome> {
    const entry: QueueEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      orderId,
      path,
      body,
      baseVersion: typeof body.version === "number" ? body.version : undefined,
      createdAt: Date.now(),
    };
    await this.save([...(await this.queue()), entry]);
    await this.flush();
    // A flush already running when this edit arrived read the queue without it.
    if (!this.outcomes.has(entry.id)) await this.flush();
    const out = this.outcomes.get(entry.id);
    this.outcomes.delete(entry.id);
    if (out && (out.kind === "conflict" || out.kind === "locked")) {
      // Staff are looking at this edit right now and get the conflict / lock
      // prompt directly; don't keep it blocking the order's later edits.
      await this.save((await this.queue()).filter((e) => e.id !== entry.id));
    }
    if (out) return out;
    if (!(await this.signedIn())) return { kind: "signin" };
    return { kind: "queued", waiting: (await this.queue()).length };
  }

  /** Replay queued edits in order (see module comment). Concurrent calls share one run. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const q = await this.queue();
    const stopped = new Set(q.filter((e) => e.blocked).map((e) => e.orderId));
    const chain = new Map<string, { base?: number; next: number }>();
    const done = new Set<string>();
    for (const e of q) {
      if (e.blocked || stopped.has(e.orderId)) {
        stopped.add(e.orderId);
        continue;
      }
      const link = chain.get(e.orderId);
      const body = { ...e.body };
      if (e.baseVersion !== undefined && link && link.base === e.baseVersion) body.version = link.next;
      let r: { status: number; data: any };
      try {
        r = await this.call("POST", e.path, body);
      } catch {
        break; // offline: keep this and everything after it
      }
      if (r.status === 401) break; // signed out: keep the queue for after sign-in
      const out = this.toOutcome(r.status, r.data);
      this.outcomes.set(e.id, out);
      if (out.kind === "ok") {
        chain.set(e.orderId, { base: e.baseVersion, next: out.data.version });
        done.add(e.id);
      } else if (out.kind === "conflict" || out.kind === "locked") {
        e.blocked = { kind: out.kind, current: out.current };
        stopped.add(e.orderId);
      } else {
        done.add(e.id); // invalid input can never succeed; surface it, don't retry forever
      }
    }
    // Re-read: edits may have been queued while this flush was sending.
    const latest = await this.queue();
    const blocked = new Map(q.filter((e) => e.blocked).map((e) => [e.id, e.blocked]));
    await this.save(latest.filter((e) => !done.has(e.id)).map((e) => (blocked.has(e.id) ? { ...e, blocked: blocked.get(e.id) } : e)));
  }

  /** Staff chose to drop their queued edits for an order after a conflict. */
  async discard(orderId: string): Promise<void> {
    await this.save((await this.queue()).filter((e) => e.orderId !== orderId));
    await this.flush();
  }

  async status(): Promise<QueueStatus> {
    const q = await this.queue();
    return {
      signedIn: await this.signedIn(),
      waiting: q.length,
      blocked: q.filter((e) => e.blocked).map((e) => ({ orderId: e.orderId, ...e.blocked! })),
    };
  }
}

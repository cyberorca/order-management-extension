/**
 * Fastify app factory: every route, validation and error mapping.
 * Entry points (local server, Vercel Function) only call buildApp().
 *
 * Errors: 400 invalid input / cycle / cross-order link, 401 no or invalid
 * session, 409 stale version (+current), 423 completed-order lock (+current).
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { activeStaff, signToken, verifyLogin, verifyToken } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/types.js";
import { MockPos, posPage } from "./mock.js";
import { InvalidInput, Locked, Repo, StaleVersion, type WriteOpts } from "./repo.js";

declare module "fastify" {
  interface FastifyRequest {
    staffId?: number;
  }
}

const PUBLIC = new Set(["/api/health", "/api/auth/login", "/api/health-report"]);
const str = { type: "string", minLength: 1, maxLength: 200 } as const;
const lines = { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 500 } as const;
const writeProps = { version: { type: "integer", minimum: 0 }, override: { type: "boolean" }, lines } as const;

export function buildApp(db: Db, config: Pick<Config, "sessionSecret" | "tokenTtlSeconds" | "schemas" | "enableMock">,
                         opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 64 * 1024,
    // Reject unknown fields instead of silently stripping them (health reports must
    // never smuggle customer data), and don't coerce types.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const repo = new Repo(db, config.schemas.sidecar);
  const schema = config.schemas.sidecar;

  // ------------------------------------------------------------- auth hook
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || PUBLIC.has(req.url.split("?")[0])) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const id = token ? verifyToken(token, config.sessionSecret) : null;
    // Staff row is re-checked every request: deactivation takes effect immediately.
    const staff = id === null ? null : await activeStaff(db, schema, id);
    if (!staff) return reply.code(401).send({ error: "unauthorized" });
    req.staffId = staff.staff_id;
  });

  const writeOpts = (b: { version?: number; override?: boolean; lines?: string[] }): WriteOpts =>
    ({ version: b.version, override: b.override, lines: b.lines });

  /** Run a write; map repo errors; respond with the state of the written order. */
  async function mutation(req: FastifyRequest, orderId: string, item: string | undefined,
                          write: () => Promise<number>) {
    try {
      const ref = await write();
      return { code: 200, body: await repo.stateAfterWrite(ref, orderId) };
    } catch (err) {
      if (err instanceof StaleVersion) {
        return { code: 409, body: { error: "stale version", current: await repo.currentFor(orderId, item) } };
      }
      if (err instanceof Locked) {
        return { code: 423, body: { error: "order is completed; resend with override to change it",
                                    current: await repo.currentFor(orderId, item) } };
      }
      if (err instanceof InvalidInput) return { code: 400, body: { error: err.message } };
      throw err;
    }
  }

  // ---------------------------------------------------------------- routes
  app.get("/api/health", async () => ({ status: "ok" }));

  app.post<{ Body: { username: string; password: string } }>("/api/auth/login", {
    schema: { body: { type: "object", required: ["username", "password"], additionalProperties: false,
                      properties: { username: str, password: { type: "string", minLength: 1, maxLength: 200 } } } },
  }, async (req, reply) => {
    const staff = await verifyLogin(db, schema, req.body.username, req.body.password);
    if (!staff) return reply.code(401).send({ error: "unauthorized" });
    return { ...signToken(staff.staff_id, config.sessionSecret, config.tokenTtlSeconds),
             staff: { username: staff.username, display_name: staff.display_name } };
  });

  app.post<{ Body: { ext_version: string; path: string; checks: Record<string, boolean> } }>("/api/health-report", {
    bodyLimit: 2048,
    schema: { body: { type: "object", required: ["ext_version", "path", "checks"], additionalProperties: false,
                      properties: {
                        ext_version: { type: "string", maxLength: 32 },
                        path: { type: "string", maxLength: 200 },
                        checks: { type: "object", maxProperties: 20, additionalProperties: { type: "boolean" } },
                      } } },
  }, async (req, reply) => {
    await db.query(`INSERT INTO ${schema}.health_reports (ext_version, path, checks) VALUES ($1, $2, $3)`,
                   [req.body.ext_version, req.body.path, JSON.stringify(req.body.checks)]);
    return reply.code(204).send();
  });

  app.post<{ Body: { order_id: string; lines: string[] } }>("/api/orders/lookup", {
    schema: { body: { type: "object", required: ["order_id", "lines"], additionalProperties: false,
                      properties: { order_id: str, lines } } },
  }, async (req) => repo.lookup(req.body.order_id, req.body.lines));

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>("/api/orders/:id/links",
    async (req) => repo.getState(req.params.id,
                                 req.query.lines === undefined ? undefined : req.query.lines.split(",").filter(Boolean)));

  app.get<{ Params: { id: string } }>("/api/orders/:id/audit",
    async (req) => ({ order_id: req.params.id, entries: await repo.listAudit(req.params.id) }));

  app.post<{ Params: { id: string }; Body: { lines?: string[] } }>("/api/orders/:id/complete", {
    schema: { body: { type: ["object", "null"], additionalProperties: false, properties: { lines } } },
  }, async (req) => {
    const ref = await repo.completeOrder(req.params.id, req.body?.lines ?? []);
    return repo.stateAfterWrite(ref, req.params.id);
  });

  type ItemParams = { id: string; item: string };

  app.post<{ Params: ItemParams; Body: { wearer: string; version?: number; override?: boolean; lines?: string[] } }>(
    "/api/orders/:id/items/:item/assign", {
      schema: { body: { type: "object", required: ["wearer"], additionalProperties: false,
                        properties: { wearer: { type: "string", maxLength: 100 }, ...writeProps } } },
    }, async (req, reply) => {
      const r = await mutation(req, req.params.id, req.params.item, () =>
        repo.setWearer(req.params.id, req.params.item, req.body.wearer, req.staffId!, writeOpts(req.body)));
      return reply.code(r.code).send(r.body);
    });

  app.post<{ Params: ItemParams; Body: { parent_order_item_id: string; version?: number; override?: boolean; lines?: string[] } }>(
    "/api/orders/:id/items/:item/link", {
      schema: { body: { type: "object", required: ["parent_order_item_id"], additionalProperties: false,
                        properties: { parent_order_item_id: str, ...writeProps } } },
    }, async (req, reply) => {
      const r = await mutation(req, req.params.id, req.params.item, () =>
        repo.setParent(req.params.id, req.params.item, req.body.parent_order_item_id.trim(), req.staffId!,
                       writeOpts(req.body)));
      return reply.code(r.code).send(r.body);
    });

  app.post<{ Params: ItemParams; Body: { note: string | null; version?: number; override?: boolean; lines?: string[] } }>(
    "/api/orders/:id/items/:item/note", {
      schema: { body: { type: "object", required: ["note"], additionalProperties: false,
                        properties: { note: { type: ["string", "null"], maxLength: 2000 }, ...writeProps } } },
    }, async (req, reply) => {
      const r = await mutation(req, req.params.id, req.params.item, () =>
        repo.setNote(req.params.id, req.params.item, req.body.note, req.staffId!, writeOpts(req.body)));
      return reply.code(r.code).send(r.body);
    });

  app.put<{ Params: { id: string }; Body: { version: number; override?: boolean;
                                            links: { order_item_id: string; wearer?: string | null;
                                                     parent_order_item_id?: string | null; note?: string | null }[] } }>(
    "/api/orders/:id/links", {
      schema: { body: { type: "object", required: ["version", "links"], additionalProperties: false,
                        properties: {
                          version: { type: "integer", minimum: 0 }, override: { type: "boolean" },
                          links: { type: "array", maxItems: 500, items: {
                            type: "object", required: ["order_item_id"], additionalProperties: false,
                            properties: { order_item_id: str, wearer: { type: ["string", "null"], maxLength: 100 },
                                          parent_order_item_id: { type: ["string", "null"], maxLength: 200 },
                                          note: { type: ["string", "null"], maxLength: 2000 } } } },
                        } } },
    }, async (req, reply) => {
      const r = await mutation(req, req.params.id, undefined, () =>
        repo.bulkPut(req.params.id, req.body.links, req.staffId!, req.body.version, !!req.body.override));
      return reply.code(r.code).send(r.body);
    });

  // --------------------------------------------------------------- mock POS
  if (config.enableMock) {
    const mock = new MockPos(db, config.schemas.mock);

    app.post("/rex/mock/pos/new-order", async () => mock.newOrder());

    app.post<{ Body: { orderId: string; items: { ProductId: number; Quantity?: number }[] } }>(
      "/rex/mock/pos/add-item", async (req, reply) => {
        const it = req.body?.items?.[0];
        const r = await mock.addItem(req.body?.orderId, Number(it?.ProductId), Number(it?.Quantity ?? 1) || 1);
        if ("error" in r) return reply.code(r.status!).send({ Error: r.error });
        return r.item;
      });

    app.post<{ Body: { orderId: string } }>("/rex/mock/pos/complete", async (req, reply) => {
      const r = await mock.complete(req.body?.orderId);
      return r ?? reply.code(404).send({ Error: "Unknown orderId" });
    });

    app.get<{ Querystring: { order_id?: string } }>("/pos", async (req, reply) => {
      let order = req.query.order_id ? await mock.find(req.query.order_id) : await mock.latest();
      if (!order && !req.query.order_id) order = await mock.find((await mock.newOrder()).orderId);
      if (!order) return reply.code(404).type("text/plain").send(`Unknown order ${req.query.order_id}`);
      return reply.type("text/html").send(posPage(order, await mock.lines(order.order_id)));
    });

    /** Debug view: what the sidecar holds for the order on screen (read-only, mock only). */
    app.get<{ Querystring: { order_id?: string } }>("/pos/saved", async (req, reply) => {
      const order = await mock.find(req.query.order_id);
      if (!order) return reply.code(404).send({ error: "unknown order" });
      const ids = (await mock.lines(order.order_id)).map((l) => l.order_item_id);
      return repo.lookup(MockPos.shownId(order), ids);
    });
  }

  return app;
}

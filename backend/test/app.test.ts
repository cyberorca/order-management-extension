/**
 * HTTP layer: staff-auth scenarios, route success paths, error mapping
 * (400/401/409/423), health reports, and the mock POS.
 */
import { randomUUID as guid } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { SCHEMAS, useTestDb } from "./helpers.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const t = useTestDb();
let app: FastifyInstance;
let annaId: number;

const config = (enableMock = true) =>
  ({ sessionSecret: SECRET, tokenTtlSeconds: 3600, schemas: SCHEMAS, enableMock });

async function addStaff(username: string, password: string, active = true): Promise<number> {
  return (await t.db().query<{ staff_id: number }>(
    "INSERT INTO sidecar.staff (username, password_hash, active) VALUES ($1, $2, $3) RETURNING staff_id",
    [username, await hashPassword(password), active])).rows[0].staff_id;
}

async function login(username = "anna", password = "anna-password") {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
}

let token = "";
const auth = () => ({ authorization: `Bearer ${token}` });
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload, headers: auth() });
const get = (url: string) => app.inject({ method: "GET", url, headers: auth() });

beforeEach(async () => {
  app = buildApp(t.db(), config());
  annaId = await addStaff("anna", "anna-password");
  token = (await login()).json().token;
});

// ------------------------------------------------------------- staff-auth

describe("sign in", () => {
  it("returns a token and expiry for correct credentials", async () => {
    const r = await login();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ token: expect.any(String), expires_at: expect.any(String),
                                     staff: { username: "anna" } });
  });

  it("wrong password and unknown user look the same", async () => {
    const a = await login("anna", "wrong");
    const b = await login("nobody", "whatever");
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
    expect(a.json().token).toBeUndefined();
  });

  it("stores a hash, not the password", async () => {
    const { rows } = await t.db().query<{ password_hash: string }>(
      "SELECT password_hash FROM sidecar.staff WHERE username = 'anna'");
    expect(rows[0].password_hash).not.toContain("anna-password");
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$10\$/);
  });

  it("inactive staff cannot sign in", async () => {
    await addStaff("old", "old-password", false);
    expect((await login("old", "old-password")).statusCode).toBe(401);
  });
});

describe("session required", () => {
  it("missing token is rejected with no data", async () => {
    const r = await app.inject({ method: "GET", url: `/api/orders/${guid()}/links` });
    expect(r.statusCode).toBe(401);
    expect(r.json().links).toBeUndefined();
  });

  it("expired token is rejected and nothing changes", async () => {
    const o = guid();
    const old = signToken(annaId, SECRET, 60, Date.now() - 3600_000).token;
    const r = await app.inject({ method: "POST", url: `/api/orders/${o}/items/${guid()}/assign`,
                                 payload: { wearer: "James" }, headers: { authorization: `Bearer ${old}` } });
    expect(r.statusCode).toBe(401);
    expect((await get(`/api/orders/${o}/links`)).json().order_ref).toBeNull();
  });

  it("tampered token is rejected", async () => {
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: annaId + 99, exp: 9e9 })).toString("base64url");
    for (const bad of [`${forged}.${sig}`, `${payload}.x${sig.slice(1)}`, `${payload}`, "garbage"]) {
      const r = await app.inject({ method: "GET", url: "/api/orders/x/links", headers: { authorization: `Bearer ${bad}` } });
      expect(r.statusCode).toBe(401);
    }
  });

  it("deactivated staff is rejected immediately", async () => {
    await t.db().query("UPDATE sidecar.staff SET active = FALSE WHERE staff_id = $1", [annaId]);
    expect((await post(`/api/orders/${guid()}/items/${guid()}/assign`, { wearer: "J" })).statusCode).toBe(401);
  });

  it("client cannot claim another identity", async () => {
    await addStaff("ben", "ben-password-x");
    const o = guid();
    await app.inject({ method: "POST", url: `/api/orders/${o}/items/${guid()}/assign`,
                       payload: { wearer: "James" }, headers: { ...auth(), "x-staff": "ben" } });
    const audit = (await get(`/api/orders/${o}/audit`)).json().entries;
    expect(audit[0].staff).toBe("anna");
  });

  it("health needs no token", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json()).toEqual({ status: "ok" });
  });
});

// ------------------------------------------------------------------ routes

describe("routes", () => {
  it("assign, link, note, lookup, links, audit, complete, bulk put", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    let r = await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "James", version: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json().links[0]).toMatchObject({ wearer: "James", note: null });
    r = await post(`/api/orders/${o}/items/${l3}/link`, { parent_order_item_id: l1, version: 1 });
    expect(r.statusCode).toBe(200);
    r = await post(`/api/orders/${o}/items/${l3}/note`, { note: "Hem 2cm" });
    expect(r.json().version).toBe(3);
    r = await post("/api/orders/lookup", { order_id: guid(), lines: [l1, l3] });
    expect(r.json().links).toHaveLength(2);
    r = await get(`/api/orders/${o}/links?lines=${l1}`);
    expect(r.json().links.find((l: { order_item_id: string }) => l.order_item_id === l3).orphaned).toBe(true);
    r = await get(`/api/orders/${o}/audit`);
    expect(r.json().entries.map((e: { field: string }) => e.field)).toEqual(["wearer", "parent", "note"]);
    r = await app.inject({ method: "PUT", url: `/api/orders/${o}/links`, headers: auth(),
                           payload: { version: 3, links: [{ order_item_id: l1, wearer: "Gary" }] } });
    expect(r.json().links.find((l: { order_item_id: string }) => l.order_item_id === l1).wearer).toBe("Gary");
    r = await post(`/api/orders/${o}/complete`, { lines: [l1] });
    expect(r.json().completed).toBe(true);
  });

  it("maps errors: 400 invalid, 409 stale (+current), 423 locked (+current)", async () => {
    const [o, l1, l3] = [guid(), guid(), guid()];
    await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "James" });
    expect((await post(`/api/orders/${o}/items/${l1}/link`, { parent_order_item_id: l1 })).statusCode).toBe(400);
    expect((await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "" })).statusCode).toBe(400);
    expect((await post(`/api/orders/${o}/items/${l3}/note`, { note: "x".repeat(1001) })).statusCode).toBe(400);
    expect((await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "J", bogus: 1 })).statusCode).toBe(400);
    const stale = await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "M", version: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.version).toBe(1);
    await post(`/api/orders/${o}/complete`);
    const locked = await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "M" });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().current.links[0].wearer).toBe("James");
    expect((await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "M", override: true })).statusCode).toBe(200);
  });

  it("status routes are gone", async () => {
    expect((await get("/api/statuses")).statusCode).toBe(404);
    expect((await post(`/api/orders/x/items/y/status`, { status: "ready" })).statusCode).toBe(404);
  });
});

// ------------------------------------------------------------ health report

describe("health report", () => {
  const report = (payload: unknown) => app.inject({ method: "POST", url: "/api/health-report", payload: payload as object });

  it("stores a valid report without a session", async () => {
    const r = await report({ ext_version: "0.1.0", path: "/pos", checks: { grid: true, lineIds: false } });
    expect(r.statusCode).toBe(204);
    const { rows } = await t.db().query<{ checks: unknown }>("SELECT checks FROM sidecar.health_reports");
    expect(rows[0].checks).toEqual({ grid: true, lineIds: false });
  });

  it("rejects oversized or unexpected content", async () => {
    expect((await report({ ext_version: "1", path: "/", checks: {}, customer: "Jane" })).statusCode).toBe(400);
    expect((await report({ ext_version: "1", path: "/", checks: { line: "PERM PRESS TROUSERS" } })).statusCode).toBe(400);
    const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`.repeat(5), true]));
    expect((await report({ ext_version: "1", path: "/", checks: big })).statusCode).toBe(413);
  });
});

// ---------------------------------------------------------------- mock POS

describe("mock POS", () => {
  const raw = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload });

  it("live sale shows the GUID; completing keeps data-ids and shows the number", async () => {
    const g = (await raw("POST", "/rex/mock/pos/new-order")).json().orderId;
    expect(g).toMatch(/^[0-9a-f-]{36}$/);
    for (const pid of [146344, 146344, 900001]) {
      expect((await raw("POST", "/rex/mock/pos/add-item", { orderId: g, items: [{ ProductId: pid }] })).statusCode).toBe(200);
    }
    const ids = (html: string) => [...html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
    const live = (await raw("GET", `/pos?order_id=${g}`)).body;
    expect(live).toContain(`data-order-id="${g}"`);
    expect(live).toContain("MOCK &ndash; not Retail Express");
    expect(live).toContain('id="complete-sale"');
    const done = (await raw("POST", "/rex/mock/pos/complete", { orderId: g })).json();
    expect(done.orderId).toMatch(/^\d{2}-\d{8}$/);
    const after = (await raw("GET", `/pos?order_id=${done.orderId}`)).body;
    expect(after).toContain('data-order-status="Completed"');
    expect(after).not.toContain('id="complete-sale"');
    expect(ids(after)).toEqual(ids(live));
    expect(ids(live)).toHaveLength(3);
  });

  it("saved-data view shows sidecar state for the order on screen", async () => {
    const g = (await raw("POST", "/rex/mock/pos/new-order")).json().orderId;
    const item = (await raw("POST", "/rex/mock/pos/add-item", { orderId: g, items: [{ ProductId: 146344 }] })).json().OrderItemId;
    await post(`/api/orders/${g}/items/${item}/assign`, { wearer: "James" });
    const html = (await raw("GET", `/pos?order_id=${g}`)).body;
    expect(html).toContain(`href="/pos/saved?order_id=${g}"`);
    expect((await raw("GET", `/pos/saved?order_id=${g}`)).json().links[0].wearer).toBe("James");
  });

  it("resetting the mock keeps sidecar links", async () => {
    const [o, l1] = [guid(), guid()];
    await post(`/api/orders/${o}/items/${l1}/assign`, { wearer: "James" });
    const before = (await get(`/api/orders/${o}/links`)).json();
    await t.db().exec("TRUNCATE mock.rex_order_items, mock.rex_orders");
    expect((await get(`/api/orders/${o}/links`)).json()).toEqual(before);
  });

  it("is off unless ENABLE_MOCK", async () => {
    const off = buildApp(t.db(), config(false));
    expect((await off.inject({ method: "GET", url: "/pos" })).statusCode).toBe(404);
    expect((await off.inject({ method: "POST", url: "/rex/mock/pos/new-order" })).statusCode).toBe(404);
  });
});

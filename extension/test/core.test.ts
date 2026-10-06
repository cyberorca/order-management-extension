/** Service-worker core: sign-in, token handling, and the offline queue. */
import { beforeEach, describe, expect, it } from "vitest";
import { Core, type KV } from "../src/background/core.js";

function memKV(): KV & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, async get(k) { return data[k] as never; }, async set(k, v) { data[k] = structuredClone(v); },
           async remove(k) { delete data[k]; } };
}

/** Fake backend: per-order version, 409 on stale version, optional offline switch. */
class FakeBackend {
  online = true;
  versions = new Map<string, number>();
  log: { path: string; body: any }[] = [];
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError("Failed to fetch");
    const path = String(url).replace("https://api.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/api/auth/login") {
      return body.password === "pw" ? json(200, { token: "tok" }) : json(401, { error: "unauthorized" });
    }
    if ((init?.headers as Record<string, string>)?.Authorization !== "Bearer tok") return json(401, { error: "unauthorized" });
    this.log.push({ path, body });
    const order = path.split("/")[3];
    const v = this.versions.get(order) ?? 0;
    if (body?.version !== undefined && body.version !== v) return json(409, { error: "stale", current: { version: v, links: [] } });
    this.versions.set(order, v + 1);
    return json(200, { order_id: order, version: v + 1, links: [] });
  };
}
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });

let be: FakeBackend;
let session: ReturnType<typeof memKV>;
let local: ReturnType<typeof memKV>;
let core: Core;
const assign = (order: string, version: number, wearer = "James") =>
  core.write(order, `/api/orders/${order}/items/L1/assign`, { wearer, version });

beforeEach(async () => {
  be = new FakeBackend();
  session = memKV();
  local = memKV();
  core = new Core({ backendUrl: "https://api.test", fetch: be.fetch as typeof fetch, session, local });
  await core.login("anna", "pw");
});

describe("session", () => {
  it("login stores the token; wrong password does not", async () => {
    expect(session.data.token).toBe("tok");
    const c2 = new Core({ backendUrl: "https://api.test", fetch: be.fetch as typeof fetch, session: memKV(), local: memKV() });
    expect(await c2.login("anna", "nope")).toEqual({ ok: false, error: "Wrong username or password" });
    expect(await c2.signedIn()).toBe(false);
  });

  it("a 401 clears the token and asks for sign-in; the edit stays queued", async () => {
    session.data.token = "expired";
    expect(await assign("O", 0)).toEqual({ kind: "signin" });
    expect(session.data.token).toBeUndefined();
    expect((await core.status()).waiting).toBe(1);
    await core.login("anna", "pw");
    await core.flush();
    expect((await core.status()).waiting).toBe(0);
  });
});

describe("queue", () => {
  it("online: an edit goes straight through", async () => {
    expect((await assign("O", 0)).kind).toBe("ok");
    expect((await core.status()).waiting).toBe(0);
  });

  it("sidecar goes down: edit queued with count, not saved", async () => {
    be.online = false;
    expect(await assign("O", 0)).toEqual({ kind: "queued", waiting: 1 });
    expect(be.log).toHaveLength(0);
  });

  it("replays in order when back online, chaining own versions", async () => {
    be.online = false;
    await assign("O", 0, "James");
    await core.write("O", "/api/orders/O/items/L2/note", { note: "Hem", version: 0 });
    expect((await core.status()).waiting).toBe(2);
    be.online = true;
    await core.flush();
    expect(be.log.map((l) => [l.path, l.body.version])).toEqual([
      ["/api/orders/O/items/L1/assign", 0], ["/api/orders/O/items/L2/note", 1]]);
    expect((await core.status()).waiting).toBe(0);
  });

  it("replay stops at a conflict for that order; other orders continue", async () => {
    be.online = false;
    await assign("O", 4);
    await core.write("O", "/api/orders/O/items/L2/note", { note: "x", version: 4 });
    await assign("P", 0);
    be.versions.set("O", 5); // someone else changed O meanwhile
    be.online = true;
    await core.flush();
    const st = await core.status();
    expect(st.waiting).toBe(2); // both O edits kept, P sent
    expect(st.blocked).toEqual([{ orderId: "O", kind: "conflict", current: { version: 5, links: [] } }]);
    expect(be.log.map((l) => l.path)).toEqual(["/api/orders/O/items/L1/assign", "/api/orders/P/items/L1/assign"]);
    expect(be.versions.get("O")).toBe(5); // the other change was kept
    await core.discard("O");
    expect((await core.status()).waiting).toBe(0);
  });

  it("recovery via Retry flushes immediately", async () => {
    be.online = false;
    await assign("O", 0);
    be.online = true;
    await core.flush(); // what the Retry message calls
    expect((await core.status()).waiting).toBe(0);
  });

  it("queue survives a service-worker restart", async () => {
    be.online = false;
    await assign("O", 0);
    const restarted = new Core({ backendUrl: "https://api.test", fetch: be.fetch as typeof fetch, session, local });
    be.online = true;
    await restarted.flush();
    expect((await restarted.status()).waiting).toBe(0);
    expect(be.log).toHaveLength(1);
  });
});

describe("immediate edits", () => {
  it("an online edit rejected as a conflict is not kept in the queue", async () => {
    be.versions.set("O", 3);
    expect((await assign("O", 0)).kind).toBe("conflict");
    expect(await core.status()).toMatchObject({ waiting: 0, blocked: [] });
    expect((await assign("O", 3)).kind).toBe("ok"); // next edit is not blocked
  });
});

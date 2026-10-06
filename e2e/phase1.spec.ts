/**
 * End-to-end: the built extension in Chromium against a local backend + mock
 * POS. Brief section 10 loop (steps 1-10) plus every resilience behaviour
 * from the change specs. Ported from retail-express-extensions/api/scripts/phase1_e2e.py.
 */
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, Backend, BASE, buildExtension, mockOrder, token } from "./harness.js";

const backend = new Backend();
let ctx: BrowserContext;
let page: Page;
let extId: string;
let extPath: string;
const profile = mkdtempSync(join(tmpdir(), "ome-e2e-"));
const launch = () => chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const dialogPlan: (string | boolean)[] = [];
const dialogLog: { type: string; message: string }[] = [];
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  extPath = buildExtension();
  await backend.start();
  ctx = await launch();
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  extId = new URL(sw.url()).host;
  page = await ctx.newPage();
  // One handler for the run: str -> prompt answer, true/false -> confirm.
  page.on("dialog", async (d) => {
    dialogLog.push({ type: d.type(), message: d.message() });
    const answer = dialogPlan.length ? dialogPlan.shift()! : "James";
    if (answer === false) await d.dismiss();
    else await d.accept(typeof answer === "string" ? answer : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});

test.afterAll(async () => {
  await ctx?.close();
  await backend.stop();
});

async function signIn(username = "demo", password = "demo-password") {
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.fill("#username", username);
  await opt.fill("#password", password);
  await opt.click('button[type="submit"]');
  await expect(opt.locator("#msg")).toHaveText(/Signed in/);
  await opt.close();
}

async function signOut() {
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.click("#logout");
  await expect(opt.locator("#msg")).toHaveText("Signed out.");
  await opt.close();
}

const rows = () => page.locator("#pos-grid tbody tr[data-id]");
const control = (i: number, cls: string) => rows().nth(i).locator(`.${cls}`);
const viewText = () => page.locator("#ome-view").innerText();
/** Reload and wait until the panel has rehydrated (its first lookup finished). */
async function reloadAndSettle(): Promise<void> {
  await page.reload();
  await expect(page.locator("#ome-view")).toContainText("James");
}

test("Phase 1 loop and resilience on the mock POS", async () => {
  const demo = await token("demo", "demo-password");
  const ben = await token("ben", "ben-password");
  const links = async (orderId: string) =>
    Object.fromEntries((await api(demo, "GET", `/api/orders/${encodeURIComponent(orderId)}/links`)).links
      .map((l: { order_item_id: string }) => [l.order_item_id, l]));
  // trouser, trouser (duplicate product), shorten-trouser alteration, shirt
  const { guid, items } = await mockOrder([146344, 146344, 900001, 140599]);
  const [trouser, , alt, shirt] = items;

  await test.step("sign in through the options page (no secret in the extension)", () => signIn());

  await test.step("1-2 detect the sale screen and current order", async () => {
    await page.goto(`${BASE}/pos?order_id=${guid}`);
    await expect(page.locator("#ome-panel")).toBeVisible();
    await expect(page.locator("#ome-order")).toHaveText(guid);
    await expect(page.locator("#mock-banner")).toContainText("MOCK");
  });

  await test.step("3-5 every line mapped to its OrderItemId, controls beside each", async () => {
    await expect(page.locator(".ome-assign")).toHaveCount(4);
    const ids = await rows().evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
    expect(new Set(ids).size).toBe(4);
  });

  await test.step("6-7 create a wearer and assign a line", async () => {
    dialogLog.length = 0;
    dialogPlan.push("James");
    await control(0, "ome-assign").click();
    await expect(page.locator("#ome-view")).toContainText("James");
    expect(dialogLog.map((d) => d.type)).toEqual(["prompt"]); // quantity 1: no warning
    expect((await links(guid))[trouser].wearer).toBe("James");
  });

  await test.step("8 link the alteration under its garment", async () => {
    await control(2, "ome-alt").click();
    await expect(page.locator("#ome-hint")).toBeVisible();
    await rows().nth(0).locator('td[data-field="description"]').click();
    await expect.poll(async () => (await links(guid))[alt]?.parent_order_item_id).toBe(trouser);
  });

  await test.step("9-10 persisted; close and reopen restores the grouped view", async () => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/pos?order_id=${guid}`);
    await expect(page.locator("#ome-view")).toContainText("James");
    // Alteration has no wearer of its own: drawn once, directly under its garment.
    const view = await page.locator("#ome-view > div").evaluateAll((els) =>
      els.map((e) => ({ cls: e.className, item: (e as HTMLElement).dataset.item ?? e.textContent })));
    const g = view.findIndex((v) => v.item === trouser);
    expect(view.filter((v) => v.cls.includes("ome-wearer")).map((v) => v.item)).toEqual(["James"]);
    expect(view[g + 1]).toEqual({ cls: "ome-line ome-child", item: alt });
    expect(view.filter((v) => v.item === alt)).toHaveLength(1);
  });

  await test.step("note on a line", async () => {
    dialogPlan.push("Hem 2cm, collect Fri");
    await control(2, "ome-note").click();
    await expect(page.locator(".ome-note-text")).toHaveText("Hem 2cm, collect Fri");
  });

  await test.step("quantity 2 warns 'one line = one wearer'; dismiss saves nothing", async () => {
    await rows().nth(3).locator('[data-field="quantity"]').evaluate((td) => { td.textContent = "2"; });
    dialogLog.length = 0;
    dialogPlan.push(false);
    await control(3, "ome-assign").click();
    await expect.poll(() => dialogLog.length).toBe(1);
    expect(dialogLog[0]).toMatchObject({ type: "confirm", message: expect.stringContaining("One line belongs to one wearer") });
    expect((await links(guid))[shirt]).toBeUndefined();
  });

  await test.step("orphaned link: banner, never deleted", async () => {
    await rows().nth(2).evaluate((tr) => tr.remove());
    await expect(page.locator(".ome-banner-warn")).toContainText("no longer in this order");
    expect((await links(guid))[alt].parent_order_item_id).toBe(trouser);
    await reloadAndSettle();
  });

  await test.step("409: another staff member's change wins, conflict shown", async () => {
    await api(ben, "POST", `/api/orders/${guid}/items/${shirt}/assign`, { wearer: "Michael" });
    dialogPlan.push("Gary");
    await control(1, "ome-assign").click();
    await expect(page.locator(".ome-banner-error")).toContainText("Sync conflict");
    expect((await links(guid))[shirt].wearer).toBe("Michael");
    await reloadAndSettle();
  });

  await test.step("signed out: sign-in prompt, edit not shown as saved", async () => {
    await signOut();
    dialogPlan.push("Gary");
    await control(1, "ome-assign").click();
    await expect(page.locator(".ome-banner-signin").first()).toContainText("not saved");
    expect(await viewText()).not.toContain("Gary");
    await signIn(); // queued edit is replayed after sign-in, never dropped
    await expect.poll(async () => (await links(guid))[items[1]]?.wearer).toBe("Gary");
    await reloadAndSettle();
  });

  await test.step("backend down: edit queued with count; Retry replays it", async () => {
    await backend.stop();
    dialogPlan.push("Peter");
    await control(1, "ome-assign").click();
    await expect(page.locator(".ome-banner-offline")).toContainText("1 edit(s) waiting");
    expect(await viewText()).not.toContain("Peter");
    await backend.start();
    await page.locator(".ome-banner-offline .ome-banner-action").click();
    await expect(page.locator(".ome-banner-offline")).toHaveCount(0);
    await expect(page.locator("#ome-view")).toContainText("Peter");
    expect((await links(guid))[items[1]].wearer).toBe("Peter");
  });

  await test.step("replay stops at a conflict; the other change is kept", async () => {
    await reloadAndSettle();
    await expect(page.locator("#ome-view")).toContainText("Peter");
    await backend.stop();
    dialogPlan.push("Zed");
    await control(0, "ome-assign").click();
    await expect(page.locator(".ome-banner-offline")).toContainText("1 edit(s) waiting");
    await backend.start();
    await api(ben, "POST", `/api/orders/${guid}/items/${shirt}/assign`, { wearer: "Ben" });
    await page.locator(".ome-banner-offline .ome-banner-action").click();
    await expect(page.locator(".ome-banner-conflict")).toContainText("someone else changed this order");
    expect((await links(guid))[trouser].wearer).toBe("James");
    expect((await links(guid))[shirt].wearer).toBe("Ben");
    await page.locator(".ome-banner-conflict .ome-banner-action").click();
    await expect(page.locator(".ome-banner-conflict")).toHaveCount(0);
  });

  let number = "";
  await test.step("complete sale -> reopened by order number -> links restored by OrderItemId", async () => {
    await page.click("#complete-sale");
    await expect(page.locator("body")).toHaveAttribute("data-order-status", "Completed");
    number = (await page.locator("body").getAttribute("data-order-id"))!;
    expect(number).toMatch(/^\d{2}-\d{8}$/);
    await expect(page.locator("#ome-order")).toContainText("completed");
    const st = await api(demo, "GET", `/api/orders/${number}/links`);
    expect(st.completed).toBe(true);
    expect(new Set(st.aliases)).toEqual(new Set([guid, number]));
    expect(st.links.find((l: { order_item_id: string }) => l.order_item_id === alt).parent_order_item_id).toBe(trouser);
  });

  await test.step("completed order: lock banner; dismissing saves nothing", async () => {
    dialogPlan.push("Michael", false);
    await control(0, "ome-assign").click();
    await expect(page.locator(".ome-banner-lock")).toBeVisible();
    expect((await links(number))[trouser].wearer).toBe("James");
  });

  await test.step("override applied and audited", async () => {
    dialogPlan.push("Michael", true);
    await control(0, "ome-assign").click();
    await expect.poll(async () => (await links(number))[trouser].wearer).toBe("Michael");
    const audit = (await api(demo, "GET", `/api/orders/${number}/audit`)).entries;
    expect(audit.some((e: { field: string; new_value: string; staff: string }) =>
      e.field === "override" && e.new_value === "wearer" && e.staff === "demo")).toBe(true);
  });

  await test.step("new sale next to the previous order's lines is its own order", async () => {
    await page.click("#new-order");
    await expect(page.locator("body")).toHaveAttribute("data-order-id", /^[0-9a-f-]{36}$/);
    const fresh = (await page.locator("body").getAttribute("data-order-id"))!;
    await page.selectOption("#product-pick", "158210");
    await page.click("#add-item");
    await expect(page.locator(".ome-assign")).toHaveCount(1);
    dialogPlan.push("Andi");
    await control(0, "ome-assign").click();
    await expect(page.locator("#ome-view")).toContainText("Andi");
    const st = await api(demo, "GET", `/api/orders/${fresh}/links`);
    expect(st.aliases).toEqual([fresh]);
    expect(st.links).toHaveLength(1);
    expect((await api(demo, "GET", `/api/orders/${number}/links`)).aliases).not.toContain(fresh);
  });

  await test.step("ids gone but seen on the network: payload layer keeps the lines mapped", async () => {
    await rows().evaluateAll((els) => els.forEach((e) => e.removeAttribute("data-id")));
    await page.waitForTimeout(600);
    await expect(page.locator("#ome-health-warning")).toHaveCount(0);
    await expect(page.locator(".ome-assign")).toHaveCount(1);
  });

  await test.step("page not recognised: visible warning, no controls, page still usable", async () => {
    await page.reload(); // no intercepted payloads on a fresh load
    await expect(page.locator(".ome-assign")).toHaveCount(1);
    await rows().evaluateAll((els) => els.forEach((e) => e.removeAttribute("data-id")));
    await expect(page.locator("#ome-health-warning")).toContainText("page not recognised");
    await expect(page.locator(".ome-cellbtn")).toHaveCount(0);
    await expect(page.locator("#new-order")).toBeEnabled();
  });

  await test.step("browser restart clears the session token (sign in again)", async () => {
    await ctx.close();
    ctx = await launch(); // same profile: storage.local survives, storage.session must not
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await expect(opt.locator("#msg")).toHaveText("Not signed in.");
  });

  await test.step("no CORS or page errors during the run", async () => {
    expect(consoleErrors.filter((e) => /CORS|Access-Control|Uncaught/i.test(e))).toEqual([]);
  });
});

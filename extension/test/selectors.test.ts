/** Resilience rule: every page selector lives in selectors.ts (CLAUDE.md). */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("selectors live in one file", () => {
  it("no other source file contains a Retail Express page selector", () => {
    const pageSelector = /data-id|data-field|data-order|data-uid|tr\[|\btd\[|"orderId"|OrderItemId"/;
    const offenders = files("src")
      .filter((f) => /\.ts$/.test(f) && !f.endsWith("selectors.ts"))
      .filter((f) => pageSelector.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("extension package", () => {
  it("contains no secrets", () => {
    execFileSync("node", ["build.mjs"], { env: { ...process.env, BACKEND_URL: "https://ome.example.app" } });
    const all = files("dist").map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).toContain("https://ome.example.app"); // the only baked-in value
    for (const secret of [/SESSION_SECRET/, /DATABASE_URL/, /postgres(ql)?:\/\//i, /npg_[A-Za-z0-9]/, /sk_live|api[_-]?key\s*[:=]/i]) {
      expect(all).not.toMatch(secret);
    }
    const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    expect(manifest.permissions).toEqual(["storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(["https://ome.example.app/*"]);
  });
});

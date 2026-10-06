/**
 * Build the unpacked extension into dist/.
 *   BACKEND_URL  backend origin (default http://127.0.0.1:3000)
 *   PAGE_MATCHES comma-separated content-script match patterns (default: the backend's /pos mock)
 * Only the backend URL is baked in - never a secret.
 */
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const backend = (process.env.BACKEND_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const origin = new URL(backend).origin;
const matches = (process.env.PAGE_MATCHES ?? `${origin}/pos*`).split(",").map((s) => s.trim()).filter(Boolean);
const out = "dist";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const common = { bundle: true, format: "iife", target: "chrome120", logLevel: "warning", define: { __BACKEND_URL__: JSON.stringify(backend) } };
await build({ ...common, entryPoints: ["src/content/index.ts"], outfile: `${out}/content.js` });
await build({ ...common, entryPoints: ["src/content/page-hook.ts"], outfile: `${out}/page-hook.js` });
await build({ ...common, entryPoints: ["src/background/sw.ts"], outfile: `${out}/sw.js` });
await build({ ...common, entryPoints: ["src/options/options.ts"], outfile: `${out}/options.js` });
await cp("src/content/panel.css", `${out}/panel.css`);
await cp("src/options/options.html", `${out}/options.html`);

const manifest = {
  manifest_version: 3,
  name: "Order Links (POC)",
  version: "0.1.0",
  description: "Assign wearers and link order lines inside the POS. Stores only the extra layer.",
  permissions: ["storage", "alarms"],
  host_permissions: [...new Set([`${origin}/*`, ...matches.map((m) => `${new URL(m.replace("*", "")).origin}/*`)])],
  background: { service_worker: "sw.js" },
  options_page: "options.html",
  content_scripts: [
    { matches, js: ["page-hook.js"], run_at: "document_start", world: "MAIN" },
    { matches, js: ["content.js"], css: ["panel.css"], run_at: "document_idle" },
  ],
};
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Built ${out}/ for backend ${backend}; pages: ${matches.join(", ")}`);

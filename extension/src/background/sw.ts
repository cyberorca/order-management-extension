/**
 * MV3 service worker: the only place that talks to the backend (content
 * scripts message it), so host_permissions apply and CORS never does.
 */
import type { Push, Request } from "../shared/messages.js";
import { Core, type KV } from "./core.js";

declare const __BACKEND_URL__: string;

const kv = (area: chrome.storage.StorageArea): KV => ({
  async get(key) {
    return (await area.get(key))[key] as never;
  },
  set: (key, value) => area.set({ [key]: value }),
  remove: (key) => area.remove(key),
});

const core = new Core({
  backendUrl: __BACKEND_URL__,
  fetch: (...a) => fetch(...a),
  session: kv(chrome.storage.session),
  local: kv(chrome.storage.local),
});

const ALARM = "ome-flush";
const tabs = new Set<number>();

/** Tell every tab showing the panel about queue / sign-in changes; keep retrying while edits wait. */
async function broadcast(): Promise<void> {
  const status = await core.status();
  if (status.waiting > status.blocked.length) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  else await chrome.alarms.clear(ALARM);
  const msg: Push = { type: "queue", status };
  for (const id of tabs) chrome.tabs.sendMessage(id, msg).catch(() => tabs.delete(id));
}

async function handle(req: Request | { type: "login"; username: string; password: string } | { type: "logout" },
                      tabId?: number): Promise<unknown> {
  if (tabId !== undefined) tabs.add(tabId);
  switch (req.type) {
    case "login": return core.login(req.username, req.password);
    case "logout": return core.logout();
    case "lookup": return core.lookup(req.orderId, req.lines);
    case "write": return core.write(req.orderId, req.path, req.body);
    case "complete": return core.complete(req.orderId, req.lines);
    case "health": return core.health(req.report);
    case "status": return core.status();
    case "retry": await core.flush(); return core.status();
    case "discard": await core.discard(req.orderId); return core.status();
    case "openOptions": return chrome.runtime.openOptionsPage();
  }
}

chrome.runtime.onMessage.addListener((req, sender, respond) => {
  handle(req, sender.tab?.id)
    .then(respond, (err) => respond({ kind: "error", message: String(err) }))
    .finally(() => void broadcast());
  return true; // async response
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void core.flush().finally(() => void broadcast());
});

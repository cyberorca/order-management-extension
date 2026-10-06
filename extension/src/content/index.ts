/** Bundled content-script entry: wires chrome.* into start(). */
import type { Push } from "../shared/messages.js";
import { start } from "./main.js";

start({
  doc: document,
  win: window,
  bridge: { send: (req) => chrome.runtime.sendMessage(req) },
  dialogs: { prompt: (m, v) => window.prompt(m, v), confirm: (m) => window.confirm(m) },
  version: chrome.runtime.getManifest().version,
  onPush: (cb) => chrome.runtime.onMessage.addListener((msg: Push) => cb(msg)),
});

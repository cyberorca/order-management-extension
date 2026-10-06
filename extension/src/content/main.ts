/**
 * Content-script entry: health check, change detection, fail-safe.
 *
 * Fail-safe (page-resilience spec): any unexpected error removes everything
 * the extension added, stops observing, sends one health report, and leaves
 * Retail Express untouched until the page reloads.
 */
import type { Push, Request } from "../shared/messages.js";
import { detectLines, detectOrderId, detectOrderStatus, newPayloadState, scanPayload } from "./detect.js";
import { checkHealth, clearWarning, healthReport, showWarning } from "./health.js";
import { type Bridge, type Dialogs, Panel } from "./panel.js";
import { SEL } from "../selectors.js";

export const DEBOUNCE_MS = 300;

export interface Env {
  doc: Document;
  win: Window;
  bridge: Bridge;
  dialogs: Dialogs;
  version: string;
  onPush?: (cb: (msg: Push) => void) => void;
}

export function start(env: Env): { stop: () => void; disabled: () => boolean } {
  const { doc, win, bridge } = env;
  const payload = newPayloadState();
  let panel: Panel | null = null;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = "";
  let reported = false;
  let off = false;

  const report = (checks: Record<string, boolean>) => {
    if (reported) return;
    reported = true;
    void bridge.send({ type: "health", report: healthReport(checks, env.version, win.location.pathname) } as Request)
      .catch(() => {});
  };

  function disable(err: unknown): void {
    if (off) return;
    off = true;
    try {
      observer?.disconnect();
      clearTimeout(timer);
      panel?.destroy();
      panel = null;
      console.warn("[Order Links] disabled after an unexpected error; Retail Express is unaffected.", err);
      report({ runtime: false });
    } catch { /* last resort: never throw into the page */ }
  }

  const guard = <A extends unknown[]>(fn: (...a: A) => unknown) => (...a: A) => {
    if (off) return;
    try {
      const r = fn(...a);
      if (r instanceof Promise) r.catch(disable);
    } catch (err) {
      disable(err);
    }
  };

  const tick = guard(async () => {
    const health = checkHealth(doc, payload);
    if (!health.saleScreen) return; // not a sale screen: stay out of the way
    if (!health.ok) {
      panel?.destroy();
      panel = null;
      lastKey = "";
      showWarning(doc, health.checks);
      report(health.checks);
      return;
    }
    clearWarning(doc);
    const orderId = detectOrderId(doc, payload);
    const rows = detectLines(doc, payload);
    const status = detectOrderStatus(doc);
    const key = `${orderId}|${status}|${rows.map((r) => r.orderItemId).join(",")}`;
    if (key === lastKey) return; // our own DOM changes or no-op re-render
    lastKey = key;
    panel ??= new Panel(doc, bridge, env.dialogs);
    if (panel.orderId !== orderId) panel.cancelPending();
    panel.orderId = orderId;
    panel.rows = rows;
    panel.injectControls();
    panel.render();
    await panel.refresh(status === SEL.completedStatus);
  });

  /** Many mutations in a burst -> one tick after it settles. */
  const schedule = () => {
    if (off) return;
    clearTimeout(timer);
    timer = setTimeout(tick, DEBOUNCE_MS);
  };

  const onMessage = guard((ev: MessageEvent) => {
    if (ev.source !== win || !ev.data?.__ome) return;
    scanPayload(payload, ev.data.__ome.request);
    scanPayload(payload, ev.data.__ome.response);
    schedule();
  });
  win.addEventListener("message", onMessage);

  env.onPush?.(guard((msg: Push) => {
    if (msg.type === "queue") panel?.setQueue(msg.status);
  }));

  const MO = (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
  const obs = new MO(guard((records: MutationRecord[]) => {
    // Ignore mutations inside our own elements.
    if (records.every((r) => (r.target as Element).closest?.("#ome-panel, .ome-cellbtn, #ome-health-warning"))) return;
    schedule();
  }));
  observer = obs;
  obs.observe(doc.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: [SEL.lineIdAttr, SEL.orderIdAttr, SEL.orderStatusAttr],
  });
  tick();

  return {
    stop: () => { observer?.disconnect(); clearTimeout(timer); win.removeEventListener("message", onMessage); panel?.destroy(); },
    disabled: () => off,
  };
}

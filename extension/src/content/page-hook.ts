/**
 * Runs in the page's MAIN world: watches fetch/XHR for order traffic and posts
 * the bodies to the extension's isolated world (detection layer 1). Never
 * changes a request or response; any error is swallowed so RE keeps working.
 */
import { SEL } from "../selectors.js";

(() => {
  const w = window as unknown as { __omeHook?: boolean };
  if (w.__omeHook) return;
  w.__omeHook = true;

  const emit = (url: string, request: string | null, response: string | null) => {
    try {
      const blob = `${url}\n${request ?? ""}\n${response ?? ""}`;
      if (!SEL.payloadUrlFilter.test(blob) || blob.length > 200_000) return;
      window.postMessage({ __ome: { request, response } }, window.location.origin);
    } catch { /* never break the page */ }
  };

  try {
    const orig = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const req = typeof init?.body === "string" ? init.body : null;
      return orig.call(this, input, init).then((resp) => {
        try { resp.clone().text().then((t) => emit(url, req, t), () => {}); } catch { /* ignore */ }
        return resp;
      });
    };
  } catch { /* ignore */ }

  try {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __omeUrl?: string }, ...args: unknown[]) {
      this.__omeUrl = String(args[1]);
      return (open as (...a: unknown[]) => void).apply(this, args);
    };
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __omeUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
      const req = typeof body === "string" ? body : null;
      this.addEventListener("load", () => {
        try { emit(this.__omeUrl ?? "", req, this.responseText); } catch { /* ignore */ }
      });
      return send.call(this, body);
    };
  } catch { /* ignore */ }
})();

/** Staff sign-in. The password goes straight to the backend; only the session token is kept. */
const msg = document.getElementById("msg")!;
const show = (text: string, ok: boolean) => { msg.textContent = text; msg.className = ok ? "ok" : "err"; };

chrome.runtime.sendMessage({ type: "status" }).then((s: { signedIn: boolean }) =>
  show(s.signedIn ? "Signed in." : "Not signed in.", s.signedIn));

document.getElementById("form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = (document.getElementById("username") as HTMLInputElement).value.trim();
  const password = (document.getElementById("password") as HTMLInputElement).value;
  const r: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({ type: "login", username, password });
  (document.getElementById("password") as HTMLInputElement).value = "";
  show(r.ok ? "Signed in. You can close this tab." : r.error ?? "Sign-in failed", r.ok);
});

document.getElementById("logout")!.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "logout" });
  show("Signed out.", true);
});

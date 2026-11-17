export const devTunnelAuthScript = `"use strict";
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const credential = params.get("credential");
const state = params.get("state");
const callback = params.get("callback");
const status = document.getElementById("status");
const button = document.getElementById("continue");
let callbackUrl;
try { callbackUrl = new URL(callback); } catch {}
const valid = credential && /^[\\w-]{32,128}$/.test(state || "") && callbackUrl &&
  ["t3code:", "t3code-dev:", "t3code-preview:"].includes(callbackUrl.protocol) &&
  callbackUrl.host === "dev-tunnel-auth" && !callbackUrl.username && !callbackUrl.password &&
  !callbackUrl.search && !callbackUrl.hash &&
  (callbackUrl.pathname === "" || callbackUrl.pathname === "/");
if (!valid) {
  status.textContent = "Open this page using Renew tunnel access in T3 Code.";
} else {
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Renewing access…";
    try {
      const response = await fetch("/api/dev-tunnel/token", {
        method: "POST", headers: { authorization: "Bearer " + credential },
        credentials: "omit", redirect: "error", cache: "no-store"
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "This T3 session is no longer authorized. Create a new pairing link on the host."
        : "Could not renew access. Check Dev Tunnels and the account login on the host.");
      const result = await response.json();
      if (typeof result.token !== "string" || !result.token ||
          !Number.isFinite(result.expiresAtEpochMs) || result.expiresAtEpochMs <= Date.now()) {
        throw new Error("The host returned an invalid connect credential.");
      }
      callbackUrl.hash = new URLSearchParams({ state, origin: location.origin, tunnelToken: result.token });
      status.textContent = "Returning to T3 Code…";
      location.replace(callbackUrl.toString());
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not renew access.";
      button.disabled = false;
    }
  });
}`;

export const devTunnelAuthHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Renew tunnel access · T3 Code</title>
<style>body{font:16px system-ui;max-width:32rem;margin:12vh auto;padding:1.5rem;color-scheme:light dark}button{font:inherit;padding:.6rem 1rem;cursor:pointer}p{line-height:1.5}</style></head>
<body><h1>Renew tunnel access</h1><p id="status">Continue to reconnect your T3 Code app to this machine.</p>
<button id="continue" disabled>Continue in T3 Code</button><script>${devTunnelAuthScript}</script></body></html>`;

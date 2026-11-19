import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";

import { devTunnelAuthScript } from "./devTunnelAuthHtml.ts";

describe("native tunnel browser recovery", () => {
  it.each([
    {
      name: "renews access using tunnel cookies and returns only the connect token",
      status: 200,
      challenge: null,
      body: { token: "connect-only", expiresAtEpochMs: 4_102_444_800_000 },
      error: null,
    },
    {
      name: "distinguishes a tunnel gateway rejection from an invalid T3 session",
      status: 401,
      challenge: "tunnel",
      body: null,
      error:
        "The Dev Tunnel rejected browser sign-in. Choose Renew tunnel access in T3 Code again and sign in.",
    },
    {
      name: "reports an invalid T3 session only for a T3 authentication error",
      status: 401,
      challenge: null,
      body: { code: "auth_invalid" },
      error: "This T3 session is no longer authorized. Create a new pairing link on the host.",
    },
    {
      name: "explains when the T3 session cannot manage access",
      status: 403,
      challenge: null,
      body: { code: "insufficient_scope" },
      error:
        "This T3 session cannot renew tunnel access. Create a new pairing link on the host with access management permission.",
    },
    {
      name: "does not blame the T3 session for an unrecognized rejection",
      status: 401,
      challenge: null,
      body: null,
      error: "Could not renew access. Check Dev Tunnels and the account login on the host.",
    },
  ])("$name", async ({ status, challenge, body, error }) => {
    let click: (() => Promise<void>) | undefined;
    let replaced = "";
    let cleared = false;
    const statusElement = { textContent: "" };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const button = {
      disabled: true,
      addEventListener: (_event: string, callback: () => Promise<void>) => {
        click = callback;
      },
    };
    const location = {
      origin: "https://machine.usw2.devtunnels.ms",
      pathname: "/auth/dev-tunnel",
      hash: `#${new URLSearchParams({ credential: "existing-t3-bearer", state: "01234567890123456789012345678901", callback: "t3code://dev-tunnel-auth" })}`,
      replace: (value: string) => {
        replaced = value;
      },
    };
    NodeVM.runInNewContext(devTunnelAuthScript, {
      URL,
      URLSearchParams,
      location,
      history: {
        replaceState: () => {
          cleared = true;
        },
      },
      document: {
        getElementById: (id: string) => (id === "continue" ? button : statusElement),
      },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(body === null ? null : JSON.stringify(body), {
          status,
          headers: challenge === null ? {} : { "www-authenticate": challenge },
        });
      },
    });
    expect(cleared).toBe(true);
    expect(requests).toEqual([]);
    expect(button.disabled).toBe(false);
    await click?.();
    expect(requests).toEqual([
      {
        url: "/api/dev-tunnel/token",
        init: {
          method: "POST",
          headers: { authorization: "Bearer existing-t3-bearer" },
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
        },
      },
    ]);
    if (error !== null) {
      expect(statusElement.textContent).toBe(error);
      expect(button.disabled).toBe(false);
      expect(replaced).toBe("");
      return;
    }
    const callback = new URL(replaced);
    expect(callback.protocol).toBe("t3code:");
    expect(callback.search).toBe("");
    const fragment = new URLSearchParams(callback.hash.slice(1));
    expect(fragment.get("tunnelToken")).toBe("connect-only");
    expect(fragment.get("origin")).toBe(location.origin);
    expect(replaced).not.toContain("existing-t3-bearer");
  });
});

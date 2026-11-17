import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";

import { devTunnelAuthScript } from "./devTunnelAuthHtml.ts";

describe("native tunnel browser recovery", () => {
  it("clears the session fragment before a consented request and returns only the connect token", async () => {
    let click: (() => Promise<void>) | undefined;
    let replaced = "";
    let cleared = false;
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
        getElementById: (id: string) => (id === "continue" ? button : { textContent: "" }),
      },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({ token: "connect-only", expiresAtEpochMs: 4_102_444_800_000 }),
        };
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
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
        },
      },
    ]);
    const callback = new URL(replaced);
    expect(callback.protocol).toBe("t3code:");
    expect(callback.search).toBe("");
    const fragment = new URLSearchParams(callback.hash.slice(1));
    expect(fragment.get("tunnelToken")).toBe("connect-only");
    expect(fragment.get("origin")).toBe(location.origin);
    expect(replaced).not.toContain("existing-t3-bearer");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { buildDevTunnelAuthUrl, readDevTunnelAuthCallback } from "./devTunnelAuth.ts";

const request = {
  httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
  credential: "t3-session",
  state: "01234567890123456789012345678901",
  callbackUrl: "t3code-dev://dev-tunnel-auth",
};

describe("native Dev Tunnel authentication handoff", () => {
  it("keeps credentials and state in the fragment of the owning tunnel", () => {
    const url = new URL(buildDevTunnelAuthUrl(request));
    expect(url.origin).toBe(new URL(request.httpBaseUrl).origin);
    expect(url.pathname).toBe("/auth/dev-tunnel");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("credential")).toBe(request.credential);
    expect(new URLSearchParams(url.hash.slice(1)).get("callback")).toBe(request.callbackUrl);
  });

  it("accepts only the pending app, state, and exact machine origin", () => {
    const callback = new URL(request.callbackUrl);
    callback.hash = new URLSearchParams({
      state: request.state,
      origin: new URL(request.httpBaseUrl).origin,
      tunnelToken: "new-connect-token",
    }).toString();
    expect(readDevTunnelAuthCallback(callback.toString(), request)).toBe("new-connect-token");
    for (const [key, value] of [
      ["state", "an-unrequested-state"],
      ["origin", "https://another-3773.usw2.devtunnels.ms"],
      ["tunnelToken", ""],
    ]) {
      const changed = new URL(callback);
      const params = new URLSearchParams(changed.hash.slice(1));
      params.set(key!, value!);
      changed.hash = params.toString();
      expect(readDevTunnelAuthCallback(changed.toString(), request)).toBeNull();
    }
    expect(
      readDevTunnelAuthCallback(callback.toString().replace("t3code-dev:", "t3code:"), request),
    ).toBeNull();
  });

  it.each([
    "http://machine-3773.usw2.devtunnels.ms",
    "https://machine-3773.usw2.devtunnels.ms.attacker.test",
    "https://user:password@machine-3773.usw2.devtunnels.ms",
    "https://machine-3773.usw2.devtunnels.ms:8443",
  ])("refuses to send a session credential to %s", (httpBaseUrl: string) => {
    expect(() => buildDevTunnelAuthUrl({ ...request, httpBaseUrl })).toThrow();
  });

  it.each(["https://attacker.test", "t3code://pair", "t3code://dev-tunnel-auth/extra"])(
    "rejects an unrelated callback %s",
    (callbackUrl: string) =>
      expect(() => buildDevTunnelAuthUrl({ ...request, callbackUrl })).toThrow(),
  );
});

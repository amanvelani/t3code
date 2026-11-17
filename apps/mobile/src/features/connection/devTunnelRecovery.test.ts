(globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  WebBrowserResultType: {
    CANCEL: "cancel",
    DISMISS: "dismiss",
    OPENED: "opened",
    LOCKED: "locked",
  },
}));

import { WebBrowserResultType } from "expo-web-browser";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { scheme: "t3code" } },
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
}));

vi.mock("../../connection/runtime", () => ({
  connectionAtomRuntime: {},
}));

import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionCatalogEntry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  devTunnelCallbackUrl,
  findDevTunnelRoute,
  generateDevTunnelState,
  isDevTunnelAuthBlocked,
  renewDevTunnelAuth,
  DEV_TUNNEL_AUTH_MAX_LIFETIME_MS,
} from "./devTunnelRecovery";

describe("devTunnelCallbackUrl", () => {
  it("formats callback URL for development variant", () => {
    expect(devTunnelCallbackUrl("t3code-dev")).toBe("t3code-dev://dev-tunnel-auth");
  });

  it("formats callback URL for preview variant", () => {
    expect(devTunnelCallbackUrl("t3code-preview")).toBe("t3code-preview://dev-tunnel-auth");
  });

  it("formats callback URL for production variant", () => {
    expect(devTunnelCallbackUrl("t3code")).toBe("t3code://dev-tunnel-auth");
  });
});

describe("generateDevTunnelState", () => {
  it("produces valid state matching dev tunnel specification", () => {
    const state = generateDevTunnelState();
    expect(state).toMatch(/^[\w-]{32,128}$/);
    expect(state.length).toBe(64);
  });

  it("generates unique values on subsequent calls", () => {
    const state1 = generateDevTunnelState();
    const state2 = generateDevTunnelState();
    expect(state1).not.toBe(state2);
  });
});

describe("findDevTunnelRoute and isDevTunnelAuthBlocked", () => {
  const envId = EnvironmentId.make("env-1");
  const tunnelTarget = new BearerConnectionTarget({
    environmentId: envId,
    label: "Dev Host",
    connectionId: "conn-tunnel",
  });
  const tunnelProfile = new BearerConnectionProfile({
    connectionId: "conn-tunnel",
    environmentId: envId,
    label: "Dev Host",
    httpBaseUrl: "https://my-tunnel.asse.devtunnels.ms",
    wsBaseUrl: "wss://my-tunnel.asse.devtunnels.ms",
  });

  const devTunnelEntry: ConnectionCatalogEntry = {
    target: tunnelTarget,
    profile: Option.some(tunnelProfile),
    enabled: true,
  };

  const directEntry: ConnectionCatalogEntry = {
    target: new BearerConnectionTarget({
      environmentId: envId,
      label: "Direct Host",
      connectionId: "conn-direct",
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "conn-direct",
        environmentId: envId,
        label: "Direct Host",
        httpBaseUrl: "https://192.168.1.100:4430",
        wsBaseUrl: "wss://192.168.1.100:4430",
      }),
    ),
    enabled: true,
  };

  it("identifies Dev Tunnel routes correctly", () => {
    expect(findDevTunnelRoute(devTunnelEntry)).not.toBeNull();
    expect(findDevTunnelRoute(directEntry)).toBeNull();
  });

  it("detects blocked authentication on Dev Tunnel route", () => {
    const blockedState: SupervisorConnectionState = {
      desired: true,
      network: "online",
      phase: "blocked",
      stage: null,
      attempt: 1,
      generation: 1,
      lastFailure: new ConnectionBlockedError({
        reason: "authentication",
        detail: "Dev Tunnel token has expired. Sign in again on the host to refresh.",
        hop: "tunnel",
      }),
      retryAt: null,
    };

    expect(isDevTunnelAuthBlocked(blockedState, devTunnelEntry)).toBe(true);
    expect(isDevTunnelAuthBlocked(blockedState, directEntry)).toBe(false);
  });

  it("returns false when connection is active or connected", () => {
    const connectedState: SupervisorConnectionState = {
      desired: true,
      network: "online",
      phase: "connected",
      stage: null,
      attempt: 1,
      generation: 1,
      lastFailure: null,
      retryAt: null,
    };

    expect(isDevTunnelAuthBlocked(connectedState, devTunnelEntry)).toBe(false);
  });
});

describe("renewDevTunnelAuth", () => {
  const envId = EnvironmentId.make("env-1");
  const httpBaseUrl = "https://tunnel-123.asse.devtunnels.ms";
  const mockTarget = {
    environmentId: envId,
    connectionId: "conn-123",
    httpBaseUrl,
    credential: "t3-bearer-secret",
  };

  it("completes full recovery flow when auth session succeeds", async () => {
    let capturedAuthUrl = "";
    let capturedCallbackUrl = "";
    let updatedToken = "";

    const openAuthSession = vi.fn(async (url: string, callbackUrl?: string) => {
      capturedAuthUrl = url;
      capturedCallbackUrl = callbackUrl ?? "";
      // Extract state from the fragment of authUrl
      const fragment = new URL(url).hash.slice(1);
      const params = new URLSearchParams(fragment);
      const state = params.get("state")!;
      return {
        type: "success" as const,
        url: `${callbackUrl}#state=${state}&origin=${encodeURIComponent(httpBaseUrl)}&tunnelToken=fresh-tunnel-token-abc`,
      };
    });

    const result = await renewDevTunnelAuth(envId, {
      getTarget: async () => mockTarget,
      updateToken: async ({ tunnelToken }) => {
        updatedToken = tunnelToken;
      },
      openAuthSession,
    });

    expect(result.status).toBe("success");
    expect(result.tunnelToken).toBe("fresh-tunnel-token-abc");
    expect(updatedToken).toBe("fresh-tunnel-token-abc");
    expect(capturedCallbackUrl).toBe("t3code://dev-tunnel-auth");
    expect(capturedAuthUrl).toContain("https://tunnel-123.asse.devtunnels.ms/auth/dev-tunnel");
  });

  it("handles user cancellation harmlessly without throwing", async () => {
    const openAuthSession = vi.fn(async () => ({
      type: WebBrowserResultType.CANCEL,
    }));

    const result = await renewDevTunnelAuth(envId, {
      getTarget: async () => mockTarget,
      updateToken: async () => {},
      openAuthSession,
    });

    expect(result.status).toBe("cancelled");
    expect(result.tunnelToken).toBeUndefined();
  });

  it("rejects when auth session exceeds 5 minutes maximum lifetime", async () => {
    let time = 1_000_000;
    const openAuthSession = vi.fn(async (_url: string, callbackUrl?: string) => {
      time += DEV_TUNNEL_AUTH_MAX_LIFETIME_MS + 10_000; // 5 min + 10s
      return {
        type: "success" as const,
        url: `${callbackUrl}#tunnelToken=expired`,
      };
    });

    await expect(
      renewDevTunnelAuth(envId, {
        getTarget: async () => mockTarget,
        updateToken: async () => {},
        openAuthSession,
        now: () => time,
      }),
    ).rejects.toThrow("Dev Tunnel authentication session expired.");
  });

  it("rejects when response state or origin does not match pending state", async () => {
    const openAuthSession = vi.fn(async (_url: string, callbackUrl?: string) => {
      return {
        type: "success" as const,
        url: `${callbackUrl}#state=mismatched-state&origin=${encodeURIComponent(httpBaseUrl)}&tunnelToken=token-xyz`,
      };
    });

    await expect(
      renewDevTunnelAuth(envId, {
        getTarget: async () => mockTarget,
        updateToken: async () => {},
        openAuthSession,
      }),
    ).rejects.toThrow("Invalid Dev Tunnel authentication response.");
  });
});

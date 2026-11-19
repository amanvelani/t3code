import { describe, expect, it, vi, beforeEach, afterEach } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  CredentialStore,
  EnvironmentRegistry,
  type ConnectionRoute,
  type ConnectionCredential,
  type ConnectionCatalogEntry,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  isDevTunnelHttpUrl,
  isDevTunnelRoute,
  isDevTunnelAuthCallback,
  getPendingDevTunnelAuth,
  setPendingDevTunnelAuth,
  clearPendingDevTunnelAuth,
  consumeDevTunnelAuthCallbackEffect,
} from "./devTunnelAuth";

describe("devTunnelAuth utilities", () => {
  it("validates Dev Tunnel HTTP URLs accurately", () => {
    expect(isDevTunnelHttpUrl("https://my-tunnel.devtunnels.ms")).toBe(true);
    expect(isDevTunnelHttpUrl("https://sub.my-tunnel.devtunnels.ms")).toBe(true);
    expect(isDevTunnelHttpUrl("http://my-tunnel.devtunnels.ms")).toBe(false);
    expect(isDevTunnelHttpUrl("https://evil.com")).toBe(false);
    expect(isDevTunnelHttpUrl("https://my-tunnel.devtunnels.ms:8080")).toBe(false);
    expect(isDevTunnelHttpUrl("invalid url")).toBe(false);
  });

  it("checks Dev Tunnel routes", () => {
    const envId = EnvironmentId.make("env-1");
    const tunnelRoute: ConnectionRoute = {
      target: new BearerConnectionTarget({
        environmentId: envId,
        label: "Tunnel Env",
        connectionId: "conn-1",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "conn-1",
          environmentId: envId,
          label: "Tunnel Env",
          httpBaseUrl: "https://my-tunnel.devtunnels.ms",
          wsBaseUrl: "wss://my-tunnel.devtunnels.ms",
        }),
      ),
    };
    expect(isDevTunnelRoute(tunnelRoute)).toBe(true);

    const nonTunnelRoute: ConnectionRoute = {
      target: new BearerConnectionTarget({
        environmentId: envId,
        label: "Normal Env",
        connectionId: "conn-2",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "conn-2",
          environmentId: envId,
          label: "Normal Env",
          httpBaseUrl: "https://example.com",
          wsBaseUrl: "wss://example.com",
        }),
      ),
    };
    expect(isDevTunnelRoute(nonTunnelRoute)).toBe(false);
  });

  it("identifies Dev Tunnel auth callback URLs", () => {
    expect(isDevTunnelAuthCallback("t3code://dev-tunnel-auth")).toBe(true);
    expect(isDevTunnelAuthCallback("t3code://dev-tunnel-auth/")).toBe(true);
    expect(isDevTunnelAuthCallback("t3code-dev://dev-tunnel-auth")).toBe(true);
    expect(isDevTunnelAuthCallback("t3code-preview://dev-tunnel-auth")).toBe(true);
    expect(isDevTunnelAuthCallback("t3code://dev-tunnel-auth?foo=bar")).toBe(false);
    expect(isDevTunnelAuthCallback("t3code://pair")).toBe(false);
    expect(isDevTunnelAuthCallback("https://dev-tunnel-auth")).toBe(false);
  });
});

describe("pending auth memory bounding and lifecycle", () => {
  const MOCK_EXPIRES_AT = 1_767_225_900_000; // 2026-01-01T00:05:00Z (5 minutes after fake start)

  beforeEach(() => {
    clearPendingDevTunnelAuth();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    clearPendingDevTunnelAuth();
    vi.useRealTimers();
  });

  it("stores pending auth and automatically expires after 5 minutes", () => {
    const envId = EnvironmentId.make("env-1");
    setPendingDevTunnelAuth({
      credential: "t3-secret-token",
      environmentId: envId,
      connectionId: "conn-1",
      httpBaseUrl: "https://my-tunnel.devtunnels.ms",
      state: "state-123",
      callbackUrl: "t3code://dev-tunnel-auth",
      expiresAtEpochMs: MOCK_EXPIRES_AT,
    });

    expect(getPendingDevTunnelAuth()?.state).toBe("state-123");

    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(getPendingDevTunnelAuth()?.state).toBe("state-123");

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(getPendingDevTunnelAuth()).toBeNull();
  });

  it.effect(
    "consumes valid callback, updates only matching route credential preserving T3 token, and retries environment",
    () =>
      Effect.gen(function* () {
        const envId = EnvironmentId.make("env-1");
        const connectionId = "conn-1";
        const initialT3Token = "t3-secret-token";
        let storedCred: ConnectionCredential = new BearerConnectionCredential({
          token: initialT3Token,
          tunnelToken: "old-tunnel-token",
        });
        let retriedEnvId: EnvironmentId | null = null;

        const mockCredStore = CredentialStore.ConnectionCredentialStore.of({
          get: (id: string) =>
            Effect.succeed(id === connectionId ? Option.some(storedCred) : Option.none()),
          put: (id, cred) => {
            if (id === connectionId) {
              storedCred = cred;
            }
            return Effect.void;
          },
          remove: () => Effect.void,
        });

        const mockRegistry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([
              [
                envId,
                {
                  target: new BearerConnectionTarget({
                    environmentId: envId,
                    connectionId,
                    label: "Tunnel",
                  }),
                  profile: Option.some(
                    new BearerConnectionProfile({
                      environmentId: envId,
                      connectionId,
                      label: "Tunnel",
                      httpBaseUrl: "https://my-tunnel.devtunnels.ms",
                      wsBaseUrl: "wss://my-tunnel.devtunnels.ms",
                    }),
                  ),
                  enabled: true,
                },
              ],
            ]),
          ),
          retryNow: (id: EnvironmentId) => {
            retriedEnvId = id;
            return Effect.void;
          },
        });

        const state = "a".repeat(64);
        setPendingDevTunnelAuth({
          credential: "t3-secret-token",
          environmentId: envId,
          connectionId,
          httpBaseUrl: "https://my-tunnel.devtunnels.ms",
          state,
          callbackUrl: "t3code://dev-tunnel-auth",
          expiresAtEpochMs: MOCK_EXPIRES_AT,
        });

        const validCallback = `t3code://dev-tunnel-auth#state=${state}&origin=${encodeURIComponent("https://my-tunnel.devtunnels.ms")}&tunnelToken=new-tunnel-token-xyz`;

        const result = yield* consumeDevTunnelAuthCallbackEffect(validCallback).pipe(
          Effect.provideService(CredentialStore.ConnectionCredentialStore, mockCredStore),
          Effect.provide(mockRegistry),
        );

        expect(result).toBe(true);
        expect(storedCred).toMatchObject({
          _tag: "BearerConnectionCredential",
          token: initialT3Token,
          tunnelToken: "new-tunnel-token-xyz",
        });
        expect(retriedEnvId).toBe(envId);
        expect(getPendingDevTunnelAuth()).toBeNull();
      }),
  );

  it.effect("rejects callback with wrong state or wrong origin", () =>
    Effect.gen(function* () {
      const envId = EnvironmentId.make("env-1");
      const connectionId = "conn-1";
      const initialT3Token = "t3-secret-token";
      let storedCred: ConnectionCredential = new BearerConnectionCredential({
        token: initialT3Token,
        tunnelToken: "old-tunnel-token",
      });

      const mockCredStore = CredentialStore.ConnectionCredentialStore.of({
        get: (id: string) =>
          Effect.succeed(id === connectionId ? Option.some(storedCred) : Option.none()),
        put: (id, cred) => {
          storedCred = cred;
          return Effect.void;
        },
        remove: () => Effect.void,
      });

      const mockRegistry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([
            [
              envId,
              {
                target: new BearerConnectionTarget({
                  environmentId: envId,
                  connectionId,
                  label: "Tunnel",
                }),
                profile: Option.some(
                  new BearerConnectionProfile({
                    environmentId: envId,
                    connectionId,
                    label: "Tunnel",
                    httpBaseUrl: "https://my-tunnel.devtunnels.ms",
                    wsBaseUrl: "wss://my-tunnel.devtunnels.ms",
                  }),
                ),
                enabled: true,
              },
            ],
          ]),
        ),
        retryNow: () => Effect.void,
      });

      const state = "b".repeat(64);
      setPendingDevTunnelAuth({
        credential: "t3-secret-token",
        environmentId: envId,
        connectionId,
        httpBaseUrl: "https://my-tunnel.devtunnels.ms",
        state,
        callbackUrl: "t3code://dev-tunnel-auth",
        expiresAtEpochMs: MOCK_EXPIRES_AT,
      });

      const wrongStateCallback = `t3code://dev-tunnel-auth#state=wrong-state&origin=${encodeURIComponent("https://my-tunnel.devtunnels.ms")}&tunnelToken=new-tunnel-token-xyz`;
      const res1 = yield* consumeDevTunnelAuthCallbackEffect(wrongStateCallback).pipe(
        Effect.provideService(CredentialStore.ConnectionCredentialStore, mockCredStore),
        Effect.provide(mockRegistry),
      );
      expect(res1).toBe(false);
      expect(storedCred).toMatchObject({ tunnelToken: "old-tunnel-token" });

      setPendingDevTunnelAuth({
        credential: "t3-secret-token",
        environmentId: envId,
        connectionId,
        httpBaseUrl: "https://my-tunnel.devtunnels.ms",
        state,
        callbackUrl: "t3code://dev-tunnel-auth",
        expiresAtEpochMs: MOCK_EXPIRES_AT,
      });

      const wrongOriginCallback = `t3code://dev-tunnel-auth#state=${state}&origin=${encodeURIComponent("https://attacker.devtunnels.ms")}&tunnelToken=new-tunnel-token-xyz`;
      const res2 = yield* consumeDevTunnelAuthCallbackEffect(wrongOriginCallback).pipe(
        Effect.provideService(CredentialStore.ConnectionCredentialStore, mockCredStore),
        Effect.provide(mockRegistry),
      );
      expect(res2).toBe(false);
      expect(storedCred).toMatchObject({ tunnelToken: "old-tunnel-token" });
    }),
  );
});

import {
  type ConnectionRoute,
  connectionRoutes,
  CredentialStore,
  EnvironmentRegistry,
  BearerConnectionCredential,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { buildDevTunnelAuthUrl, readDevTunnelAuthCallback } from "@t3tools/shared/devTunnelAuth";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "./runtime";

class DevTunnelAuthError extends Schema.TaggedError<DevTunnelAuthError>()("DevTunnelAuthError", {
  message: Schema.String,
}) {}

export interface PendingDevTunnelAuth {
  readonly environmentId: EnvironmentId;
  readonly connectionId: string;
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly state: string;
  readonly callbackUrl: string;
  readonly expiresAtEpochMs: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEV_TUNNEL_CALLBACK_SCHEMES = new Set(["t3code:", "t3code-dev:", "t3code-preview:"]);

let pendingAuth: PendingDevTunnelAuth | null = null;
let expirationTimer: ReturnType<typeof setTimeout> | null = null;

export function getPendingDevTunnelAuth(): PendingDevTunnelAuth | null {
  if (pendingAuth === null) return null;
  if (Date.now() > pendingAuth.expiresAtEpochMs) {
    clearPendingDevTunnelAuth();
    return null;
  }
  return pendingAuth;
}

export function setPendingDevTunnelAuth(auth: PendingDevTunnelAuth): void {
  if (expirationTimer) clearTimeout(expirationTimer);
  pendingAuth = auth;
  expirationTimer = setTimeout(() => {
    if (pendingAuth?.state === auth.state) {
      pendingAuth = null;
    }
  }, FIVE_MINUTES_MS);
}

export function clearPendingDevTunnelAuth(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  pendingAuth = null;
}

export function isDevTunnelHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".devtunnels.ms") &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isDevTunnelRoute(route: ConnectionRoute): boolean {
  const profile = route.profile;
  if (Option.isNone(profile) || profile.value._tag !== "BearerConnectionProfile") {
    return false;
  }
  return isDevTunnelHttpUrl(profile.value.httpBaseUrl);
}

export function isDevTunnelAuthCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      DEV_TUNNEL_CALLBACK_SCHEMES.has(url.protocol) &&
      url.host === "dev-tunnel-auth" &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search
    );
  } catch {
    return false;
  }
}

function resolveDevTunnelCallbackScheme(): string {
  if (typeof window !== "undefined" && window.location?.protocol) {
    if (DEV_TUNNEL_CALLBACK_SCHEMES.has(window.location.protocol)) {
      return `${window.location.protocol}//dev-tunnel-auth`;
    }
  }
  return "t3code://dev-tunnel-auth";
}

function generateCryptoState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const startDevTunnelAuthEffect = Effect.fn("connection.startDevTunnelAuth")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly route: ConnectionRoute;
}) {
  const profile = input.route.profile;
  if (Option.isNone(profile) || profile.value._tag !== "BearerConnectionProfile") {
    return yield* new DevTunnelAuthError({ message: "Route is not a Bearer profile" });
  }
  const httpBaseUrl = profile.value.httpBaseUrl;
  if (!isDevTunnelHttpUrl(httpBaseUrl)) {
    return yield* new DevTunnelAuthError({ message: "Route is not a Dev Tunnel" });
  }
  const connectionId = profile.value.connectionId;
  const credentialStore = yield* CredentialStore.ConnectionCredentialStore;
  const credOption = yield* credentialStore.get(connectionId);
  if (Option.isNone(credOption) || credOption.value._tag !== "BearerConnectionCredential") {
    return yield* new DevTunnelAuthError({
      message: "Missing bearer credential for route",
    });
  }
  const bearerToken = credOption.value.token;
  const state = generateCryptoState();
  const callbackUrl = resolveDevTunnelCallbackScheme();

  const authUrl = buildDevTunnelAuthUrl({
    httpBaseUrl,
    credential: bearerToken,
    state,
    callbackUrl,
  });

  const now = yield* Clock.currentTimeMillis;
  setPendingDevTunnelAuth({
    environmentId: input.environmentId,
    connectionId,
    credential: bearerToken,
    httpBaseUrl,
    state,
    callbackUrl,
    expiresAtEpochMs: now + FIVE_MINUTES_MS,
  });

  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  if (bridge?.openExternal) {
    const openExternal = bridge.openExternal;
    yield* Effect.promise(() => openExternal(authUrl));
  } else if (typeof window !== "undefined") {
    window.open(authUrl, "_blank");
  }
});

export const startDevTunnelAuth = createRuntimeCommand(connectionAtomRuntime, {
  label: "connection:start-dev-tunnel-auth",
  execute: startDevTunnelAuthEffect,
});

export const consumeDevTunnelAuthCallbackEffect = Effect.fn(
  "connection.consumeDevTunnelAuthCallback",
)(function* (callbackUrl: string) {
  const pending = getPendingDevTunnelAuth();
  if (!pending) {
    return false;
  }

  const newTunnelToken = readDevTunnelAuthCallback(callbackUrl, {
    httpBaseUrl: pending.httpBaseUrl,
    state: pending.state,
    callbackUrl: pending.callbackUrl,
  });

  if (!newTunnelToken) return false;

  const credentialStore = yield* CredentialStore.ConnectionCredentialStore;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(pending.environmentId);
  if (
    !entry ||
    !connectionRoutes(entry).some(
      (route) =>
        Option.isSome(route.profile) &&
        route.profile.value._tag === "BearerConnectionProfile" &&
        route.profile.value.connectionId === pending.connectionId &&
        new URL(route.profile.value.httpBaseUrl).origin === new URL(pending.httpBaseUrl).origin,
    )
  ) {
    clearPendingDevTunnelAuth();
    return false;
  }
  const existing = yield* credentialStore.get(pending.connectionId);
  if (
    Option.isNone(existing) ||
    existing.value._tag !== "BearerConnectionCredential" ||
    existing.value.token !== pending.credential
  ) {
    clearPendingDevTunnelAuth();
    return false;
  }

  const updated = new BearerConnectionCredential({
    token: existing.value.token,
    tunnelToken: newTunnelToken,
  });

  yield* credentialStore.put(pending.connectionId, updated);

  yield* registry.retryNow(pending.environmentId);

  clearPendingDevTunnelAuth();
  return true;
});

export const consumeDevTunnelAuthCallback = createRuntimeCommand(connectionAtomRuntime, {
  label: "connection:consume-dev-tunnel-auth-callback",
  execute: consumeDevTunnelAuthCallbackEffect,
});

import {
  BearerConnectionCredential,
  ConnectionBlockedError,
  CredentialStore,
  EnvironmentRegistry,
  connectionRouteId,
  connectionRoutes,
  routeHttpBaseUrl,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { buildDevTunnelAuthUrl, readDevTunnelAuthCallback } from "@t3tools/shared/devTunnelAuth";
import { isDevTunnelUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/reactivity";
import type { WebBrowserAuthSessionResult } from "expo-web-browser";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

export const DEV_TUNNEL_AUTH_MAX_LIFETIME_MS = 5 * 60_000;

export function devTunnelCallbackUrl(schemeOverride?: string): string {
  if (schemeOverride) return `${schemeOverride}://dev-tunnel-auth`;
  const scheme = Constants.expoConfig?.scheme;
  const resolved = (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
  return `${resolved}://dev-tunnel-auth`;
}

export function generateDevTunnelState(): string {
  const bytes = getRandomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function findDevTunnelRoute(
  entry: ConnectionCatalogEntry | null | undefined,
): ConnectionRoute | null {
  if (!entry) return null;
  const routes = connectionRoutes(entry);
  return (
    routes.find((route) => {
      const baseUrl = routeHttpBaseUrl(route);
      return baseUrl !== null && isDevTunnelUrl(baseUrl);
    }) ?? null
  );
}

export function isDevTunnelAuthBlocked(
  state: SupervisorConnectionState | null | undefined,
  entry: ConnectionCatalogEntry | null | undefined,
): boolean {
  if (!entry || !state) return false;
  const devTunnelRoute = findDevTunnelRoute(entry);
  if (!devTunnelRoute) return false;

  if (state.phase === "blocked") {
    const failure = state.lastFailure;
    if (failure && (failure.hop === "tunnel" || failure.reason === "authentication")) {
      return true;
    }
  }
  if (state.lastFailure?.hop === "tunnel" && state.lastFailure?.reason === "authentication") {
    return true;
  }
  const msg = state.lastFailure?.message?.toLowerCase() ?? "";
  if (
    msg.includes("dev tunnel") &&
    (msg.includes("token") ||
      msg.includes("auth") ||
      msg.includes("sign in") ||
      msg.includes("expired"))
  ) {
    return true;
  }
  return false;
}

const devTunnelScheduler = createAtomCommandScheduler();

export interface DevTunnelAuthTarget {
  readonly environmentId: EnvironmentId;
  readonly connectionId: string;
  readonly httpBaseUrl: string;
  readonly credential: string;
}

export const getDevTunnelAuthTarget = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:get-dev-tunnel-auth-target",
  scheduler: devTunnelScheduler,
  execute: Effect.fn("mobile.connection.getDevTunnelAuthTarget")(function* (input: {
    readonly environmentId: EnvironmentId;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const credentials = yield* CredentialStore.ConnectionCredentialStore;
    const entriesMap = yield* SubscriptionRef.get(registry.entries);
    const entry = entriesMap.get(input.environmentId);
    if (!entry) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Environment not found.",
      });
    }
    const devTunnelRoute = findDevTunnelRoute(entry);
    if (!devTunnelRoute) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "No Dev Tunnel route found for this environment.",
      });
    }
    const httpBaseUrl = routeHttpBaseUrl(devTunnelRoute);
    if (!httpBaseUrl) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Invalid Dev Tunnel route URL.",
      });
    }
    const connectionId = connectionRouteId(devTunnelRoute.target);
    const credentialOption = yield* credentials.get(connectionId);
    if (
      Option.isNone(credentialOption) ||
      credentialOption.value._tag !== "BearerConnectionCredential"
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "No saved bearer credential found for Dev Tunnel.",
      });
    }
    return {
      environmentId: input.environmentId,
      connectionId,
      httpBaseUrl,
      credential: credentialOption.value.token,
    } satisfies DevTunnelAuthTarget;
  }),
});

export const updateDevTunnelToken = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-dev-tunnel-token",
  scheduler: devTunnelScheduler,
  execute: Effect.fn("mobile.connection.updateDevTunnelToken")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly connectionId: string;
    readonly tunnelToken: string;
    readonly httpBaseUrl: string;
    readonly expectedBearerToken: string;
  }) {
    const credentials = yield* CredentialStore.ConnectionCredentialStore;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
    const currentRoute =
      entry &&
      connectionRoutes(entry).find(
        (route) => connectionRouteId(route.target) === input.connectionId,
      );
    const currentBaseUrl = currentRoute && routeHttpBaseUrl(currentRoute);
    if (!currentBaseUrl || new URL(currentBaseUrl).origin !== new URL(input.httpBaseUrl).origin) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "The tunnel connection changed. Start renewal again.",
      });
    }
    const credentialOption = yield* credentials.get(input.connectionId);
    if (
      Option.isNone(credentialOption) ||
      credentialOption.value._tag !== "BearerConnectionCredential" ||
      credentialOption.value.token !== input.expectedBearerToken
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Matching Dev Tunnel credential not found.",
      });
    }
    yield* credentials.put(
      input.connectionId,
      new BearerConnectionCredential({
        token: credentialOption.value.token,
        tunnelToken: input.tunnelToken,
      }),
    );
    yield* registry.retryNow(input.environmentId);
  }),
});

export interface RenewDevTunnelAuthOptions {
  readonly openAuthSession?: (
    url: string,
    redirectUrl?: string,
  ) => Promise<WebBrowserAuthSessionResult>;
  readonly scheme?: string;
  readonly getTarget?: (environmentId: EnvironmentId) => Promise<DevTunnelAuthTarget>;
  readonly updateToken?: (input: {
    readonly environmentId: EnvironmentId;
    readonly connectionId: string;
    readonly tunnelToken: string;
  }) => Promise<void>;
  readonly now?: () => number;
}

export async function renewDevTunnelAuth(
  environmentId: EnvironmentId,
  options?: RenewDevTunnelAuthOptions,
): Promise<{
  readonly status: "success" | "cancelled";
  readonly tunnelToken?: string;
}> {
  let target: DevTunnelAuthTarget;
  if (options?.getTarget) {
    target = await options.getTarget(environmentId);
  } else {
    const targetResult = await runAtomCommand(
      appAtomRegistry,
      getDevTunnelAuthTarget,
      { environmentId },
      { reportFailure: false, reportDefect: false },
    );
    if (AsyncResult.isFailure(targetResult)) {
      throw squashAtomCommandFailure(targetResult);
    }
    target = targetResult.value;
  }
  const { connectionId, httpBaseUrl, credential } = target;
  const state = generateDevTunnelState();
  const callbackUrl = devTunnelCallbackUrl(options?.scheme);
  const authUrl = buildDevTunnelAuthUrl({
    httpBaseUrl,
    credential,
    state,
    callbackUrl,
  });

  const nowFn = options?.now ?? Date.now;
  const startedAt = nowFn();
  const openSession =
    options?.openAuthSession ?? (await import("expo-web-browser")).openAuthSessionAsync;
  const result = await openSession(authUrl, callbackUrl);

  if (result.type !== "success" || !("url" in result) || !result.url) {
    return { status: "cancelled" };
  }

  if (nowFn() - startedAt > DEV_TUNNEL_AUTH_MAX_LIFETIME_MS) {
    throw new Error("Dev Tunnel authentication session expired.");
  }

  const tunnelToken = readDevTunnelAuthCallback(result.url, {
    httpBaseUrl,
    state,
    callbackUrl,
  });

  if (!tunnelToken) {
    throw new Error("Invalid Dev Tunnel authentication response.");
  }

  if (options?.updateToken) {
    await options.updateToken({ environmentId, connectionId, tunnelToken });
  } else {
    const updateResult = await runAtomCommand(
      appAtomRegistry,
      updateDevTunnelToken,
      { environmentId, connectionId, tunnelToken, httpBaseUrl, expectedBearerToken: credential },
      { reportFailure: false, reportDefect: false },
    );

    if (AsyncResult.isFailure(updateResult)) {
      throw squashAtomCommandFailure(updateResult);
    }
  }

  return { status: "success", tunnelToken };
}

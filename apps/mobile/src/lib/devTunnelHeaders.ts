import type { EnvironmentId } from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { isDevTunnelUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export const DEV_TUNNEL_HEADER = "X-Tunnel-Authorization";

export function devTunnelAuthorizationValue(token: string): string {
  return `tunnel ${token.trim()}`;
}

export interface DevTunnelConnectionTarget {
  readonly httpBaseUrl: string;
  readonly tunnelToken?: string;
}

const activeDevTunnels = new Map<string, DevTunnelConnectionTarget>();

export const layerActiveDevTunnels = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* Effect.addFinalizer(() => Effect.sync(clearActiveDevTunnels));
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.switchMap((entries) => {
        clearActiveDevTunnels();
        return Stream.mergeAll(
          [...entries]
            .filter(([, entry]) => entry.enabled)
            .map(([environmentId]) =>
              registry
                .runStream(
                  environmentId,
                  Stream.unwrap(
                    EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                      Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
                    ),
                  ),
                )
                .pipe(
                  Stream.map((connection) => ({
                    environmentId,
                    prepared: Option.getOrNull(connection),
                  })),
                  Stream.catch(() => Stream.empty),
                ),
            ),
          { concurrency: "unbounded" },
        );
      }),
      Stream.runForEach(({ environmentId, prepared }) =>
        Effect.sync(() => registerActiveDevTunnel(environmentId, prepared)),
      ),
      Effect.forkScoped,
    );
  }),
);

export function registerActiveDevTunnel(
  environmentId: EnvironmentId,
  connection: DevTunnelConnectionTarget | null | undefined,
): void {
  if (
    connection?.tunnelToken &&
    connection.tunnelToken.trim().length > 0 &&
    isDevTunnelUrl(connection.httpBaseUrl)
  ) {
    activeDevTunnels.set(environmentId, connection);
  } else {
    activeDevTunnels.delete(environmentId);
  }
}

export function clearActiveDevTunnels(): void {
  activeDevTunnels.clear();
}

function exactSecureOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isDevTunnelUrl(url) ? url.origin : null;
  } catch {
    return null;
  }
}

function isConnectionTarget(target: unknown): target is DevTunnelConnectionTarget {
  return typeof target === "object" && target !== null && "httpBaseUrl" in target;
}

/**
 * Derives outer Dev Tunnel headers for mobile asset/media previews, downloads,
 * uploads, attachments, and raw fetch requests.
 *
 * Headers are only attached when the requested URL's exact secure origin matches
 * the prepared connection's `httpBaseUrl`. T3 bearer tokens are never attached.
 */
export function devTunnelHeaders(
  url: string | null | undefined,
  target?: DevTunnelConnectionTarget | EnvironmentId | null,
): Record<string, string> | undefined {
  if (!url) return undefined;
  const requestedOrigin = exactSecureOrigin(url);
  if (!requestedOrigin) return undefined;

  if (isConnectionTarget(target)) {
    const tunnelToken = target.tunnelToken;
    if (!tunnelToken || tunnelToken.trim().length === 0) return undefined;
    const baseOrigin = exactSecureOrigin(target.httpBaseUrl);
    if (baseOrigin && baseOrigin === requestedOrigin) {
      return { [DEV_TUNNEL_HEADER]: devTunnelAuthorizationValue(tunnelToken) };
    }
    return undefined;
  }

  if (typeof target === "string") {
    const active = activeDevTunnels.get(target);
    if (!active?.tunnelToken || active.tunnelToken.trim().length === 0) return undefined;
    const baseOrigin = exactSecureOrigin(active.httpBaseUrl);
    if (baseOrigin && baseOrigin === requestedOrigin) {
      return { [DEV_TUNNEL_HEADER]: devTunnelAuthorizationValue(active.tunnelToken) };
    }
    return undefined;
  }

  for (const active of activeDevTunnels.values()) {
    if (!active.tunnelToken || active.tunnelToken.trim().length === 0) continue;
    const baseOrigin = exactSecureOrigin(active.httpBaseUrl);
    if (baseOrigin && baseOrigin === requestedOrigin) {
      return { [DEV_TUNNEL_HEADER]: devTunnelAuthorizationValue(active.tunnelToken) };
    }
  }

  return undefined;
}

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Electron from "electron";
import * as Schema from "effect/Schema";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { isDevTunnelUrl } from "@t3tools/shared/remote";

export interface DevTunnelSessionLike {
  readonly webRequest?: {
    readonly onBeforeSendHeaders: (
      listener:
        | ((
            details: Pick<Electron.OnBeforeSendHeadersListenerDetails, "url" | "requestHeaders">,
            callback: (beforeSendResponse: Electron.BeforeSendResponse) => void,
          ) => void)
        | null,
    ) => void;
  };
}

export function extractExactSecureOrigins(
  httpBaseUrl?: string,
  wsBaseUrl?: string,
): ReadonlyArray<string> {
  const origins = new Set<string>();

  if (httpBaseUrl) {
    try {
      const url = new URL(httpBaseUrl);
      if (url.protocol === "https:" && isDevTunnelUrl(url)) {
        origins.add(url.origin);
        origins.add(`wss://${url.host}`);
      }
    } catch {}
  }

  if (wsBaseUrl) {
    try {
      const url = new URL(wsBaseUrl);
      if (url.protocol === "wss:" && isDevTunnelUrl(url)) {
        origins.add(url.origin);
        origins.add(`https://${url.host}`);
      }
    } catch {}
  }

  return [...origins];
}

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));

export function parseTunnelTokensFromCatalog(catalogJson: string | null): Map<string, string> {
  const tokens = new Map<string, string>();
  const parsed = decodeCatalog(catalogJson);
  if (Option.isNone(parsed)) return tokens;
  const catalog = parsed.value;
  const disabled = new Set(catalog.disabledEnvironmentIds);
  for (const profile of catalog.profiles) {
    if (profile._tag !== "BearerConnectionProfile" || disabled.has(profile.environmentId)) continue;
    const credential = catalog.credentials.find(
      (entry) => entry.connectionId === profile.connectionId,
    )?.credential;
    if (!credential?.tunnelToken) continue;
    for (const origin of extractExactSecureOrigins(profile.httpBaseUrl, profile.wsBaseUrl)) {
      tokens.set(origin, credential.tunnelToken.trim());
    }
  }
  return tokens;
}

export class DesktopDevTunnelInterceptor extends Context.Service<
  DesktopDevTunnelInterceptor,
  {
    readonly updateCatalog: (catalogJson: string | null) => Effect.Effect<void>;
    readonly lookupTunnelToken: (url: string) => Option.Option<string>;
    readonly dispose: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDevTunnelInterceptor") {}

export const makeWithSession = Effect.fn("DesktopDevTunnelInterceptor.makeWithSession")(function* (
  session?: DevTunnelSessionLike,
) {
  const scope = yield* Effect.serviceOption(Scope.Scope);
  let currentTokens = new Map<string, string>();

  const targetSession = session ?? (Electron.session ? Electron.session.defaultSession : undefined);

  const listener = (
    details: Pick<Electron.OnBeforeSendHeadersListenerDetails, "url" | "requestHeaders">,
    callback: (beforeSendResponse: Electron.BeforeSendResponse) => void,
  ) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === "https:" || url.protocol === "wss:") {
        const token = currentTokens.get(url.origin);
        if (token) {
          const requestHeaders = { ...details.requestHeaders };
          requestHeaders["X-Tunnel-Authorization"] = `tunnel ${token}`;
          callback({ requestHeaders });
          return;
        }
      }
    } catch {}
    const requestHeaders = { ...details.requestHeaders };
    if (!isDevTunnelUrl(details.url)) {
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === "x-tunnel-authorization") delete requestHeaders[name];
      }
    }
    callback({ requestHeaders });
  };

  let installed = false;
  if (targetSession?.webRequest?.onBeforeSendHeaders) {
    targetSession.webRequest.onBeforeSendHeaders(listener);
    installed = true;
  }

  const dispose = Effect.sync(() => {
    if (installed && targetSession?.webRequest?.onBeforeSendHeaders) {
      targetSession.webRequest.onBeforeSendHeaders(null);
      installed = false;
    }
  });

  if (Option.isSome(scope)) {
    yield* Scope.addFinalizer(scope.value, dispose);
  }

  const updateCatalog = Effect.fn("DesktopDevTunnelInterceptor.updateCatalog")(function (
    catalogJson: string | null,
  ) {
    return Effect.sync(() => {
      currentTokens = parseTunnelTokensFromCatalog(catalogJson);
    });
  });

  const lookupTunnelToken = (rawUrl: string): Option.Option<string> => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "wss:") {
        return Option.none();
      }
      return Option.fromNullishOr(currentTokens.get(url.origin));
    } catch {
      return Option.none();
    }
  };

  return DesktopDevTunnelInterceptor.of({
    updateCatalog,
    lookupTunnelToken,
    dispose,
  });
});

export const layer = Layer.effect(DesktopDevTunnelInterceptor, makeWithSession());

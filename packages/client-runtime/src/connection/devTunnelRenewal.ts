import type { DevTunnelConnectToken } from "@t3tools/contracts";
import { devTunnelTokenExpiresAt, isDevTunnelUrl } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BearerConnectionCredential, type ConnectionCredential } from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import { ConnectionTransientError, type PreparedConnection } from "./model.ts";
import { credentialConnectionId } from "./routes.ts";

export const renewDevTunnelAccess = Effect.fn("connection.renewDevTunnelAccess")(function* <
  E,
>(input: {
  readonly prepared: PreparedConnection;
  readonly issueToken: () => Effect.Effect<DevTunnelConnectToken, E>;
}) {
  const { prepared } = input;
  if (
    !prepared.tunnelToken ||
    prepared.target._tag !== "BearerConnectionTarget" ||
    prepared.httpAuthorization?._tag !== "Bearer" ||
    !isDevTunnelUrl(prepared.httpBaseUrl)
  ) {
    return yield* Effect.never;
  }
  const expiry = devTunnelTokenExpiresAt(prepared.tunnelToken);
  if (expiry === null) return yield* Effect.never;
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sleep(Math.max(0, expiry - now - 60 * 60 * 1000));
  const credentials = yield* CredentialStore.ConnectionCredentialStore;
  const connectionId = credentialConnectionId(prepared.target.connectionId);
  const expectedBearer = prepared.httpAuthorization.token;
  const stillCurrent = (
    value: Option.Option<ConnectionCredential>,
  ): value is Option.Some<BearerConnectionCredential> =>
    Option.isSome(value) &&
    value.value._tag === "BearerConnectionCredential" &&
    value.value.token === expectedBearer &&
    value.value.tunnelToken === prepared.tunnelToken;
  const renewed = yield* Effect.gen(function* () {
    if (!stillCurrent(yield* credentials.get(connectionId))) return false;
    const token = yield* input.issueToken();
    const latest = yield* credentials.get(connectionId);
    if (!stillCurrent(latest)) return false;
    const now = yield* Clock.currentTimeMillis;
    if (!token.token || token.expiresAtEpochMs <= now + 60 * 60 * 1000) return false;
    yield* credentials.put(
      connectionId,
      new BearerConnectionCredential({
        ...latest.value,
        tunnelToken: token.token,
      }),
    );
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
  if (!renewed) return yield* Effect.never;
  // A new lease updates every HTTP and media consumer along with the socket.
  return yield* new ConnectionTransientError({
    reason: "transport",
    detail: "Dev Tunnel access renewed. Reconnecting.",
    hop: "tunnel",
  });
});

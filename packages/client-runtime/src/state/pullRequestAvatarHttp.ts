import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  RemoteEnvironmentAuthFetchError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const AZURE_AVATAR_PREFIX = "/api/pull-requests/azure-avatars/";
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TIMEOUT_MS = 30_000;

const invalidAvatarResponse = (message: string) =>
  new RemoteEnvironmentAuthFetchError({ message, cause: message });

export const fetchEnvironmentPullRequestAvatar = Effect.fn(
  "clientRuntime.state.fetchEnvironmentPullRequestAvatar",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly path: string;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
}) {
  if (!input.path.startsWith(AZURE_AVATAR_PREFIX)) {
    return yield* invalidAvatarResponse("Invalid Azure avatar path.");
  }
  const requestUrl = new URL(input.path, input.prepared.httpBaseUrl).toString();
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(requestUrl).pipe(
    HttpClientRequest.setHeaders({ accept: "image/png", ...headers }),
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AVATAR_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (
              response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
              "image/png"
            ) {
              return yield* invalidAvatarResponse(
                "The environment returned an unsupported avatar content type.",
              );
            }
            const advertisedLength = Number(response.headers["content-length"] ?? "0");
            if (Number.isFinite(advertisedLength) && advertisedLength > MAX_AVATAR_BYTES) {
              return yield* invalidAvatarResponse("The avatar is too large.");
            }
            const bytes = new Uint8Array(yield* response.arrayBuffer);
            if (bytes.length > MAX_AVATAR_BYTES) {
              return yield* invalidAvatarResponse("The avatar is too large.");
            }
            return bytes;
          }),
        ),
      ),
    ),
  );
});

export class PullRequestAvatarLoader extends Context.Service<
  PullRequestAvatarLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      path: string,
    ) => Effect.Effect<Uint8Array, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/pullRequestAvatarHttp/PullRequestAvatarLoader") {}

export const pullRequestAvatarLoaderLayer: Layer.Layer<
  PullRequestAvatarLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  PullRequestAvatarLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return PullRequestAvatarLoader.of({
      load: (prepared, path) =>
        fetchEnvironmentPullRequestAvatar({ prepared, path, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

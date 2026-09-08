import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  RemoteEnvironmentAuthFetchError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

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
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}) {
  if (!input.path.startsWith(AZURE_AVATAR_PREFIX)) {
    return yield* invalidAvatarResponse("Invalid Azure avatar path.");
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: input.signer,
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    method: "GET",
    url: (httpBaseUrl) => new URL(input.path, httpBaseUrl).toString(),
    timeoutMs: AVATAR_TIMEOUT_MS,
    request: ({ headers, requestUrl }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const request = HttpClientRequest.get(requestUrl).pipe(
          HttpClientRequest.setHeaders({ accept: "image/png", ...headers }),
        );
        return yield* client.execute(request).pipe(
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
        );
      }),
  });
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
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return PullRequestAvatarLoader.of({
      load: (prepared, path) =>
        fetchEnvironmentPullRequestAvatar({ prepared, path, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import {
  AZURE_DEVOPS_AVATAR_ROUTE_PREFIX,
  AzureDevOpsAvatar,
  parseAzureDevOpsAvatarPath,
} from "./AzureDevOpsAvatar.ts";

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const avatars = yield* AzureDevOpsAvatar;
    return HttpRouter.add(
      "GET",
      `${AZURE_DEVOPS_AVATAR_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        yield* authenticate;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }
        const avatarRequest = parseAzureDevOpsAvatarPath(url.value.pathname);
        if (avatarRequest === null) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }

        return yield* avatars.get({ ...avatarRequest, cwd: process.cwd() }).pipe(
          Effect.map((image) =>
            HttpServerResponse.uint8Array(image.bytes, {
              contentType: image.contentType,
              headers: {
                "Cache-Control": "private, max-age=3600",
                "X-Content-Type-Options": "nosniff",
              },
            }),
          ),
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to load Azure DevOps avatar", { cause }),
          ),
          Effect.orElseSucceed(() => HttpServerResponse.text("Bad Gateway", { status: 502 })),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);

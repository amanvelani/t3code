import { AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Digest from "effect/crypto/Digest";
import * as Base64 from "effect/encoding/Base64";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as DevTunnel from "./DevTunnel.ts";
import { devTunnelAuthHtml, devTunnelAuthScript } from "./devTunnelAuthHtml.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "devTunnel",
  Effect.fnUntraced(function* (handlers) {
    const tunnel = yield* DevTunnel.DevTunnel;
    return handlers.handle(
      "issueToken",
      Effect.fn("environment.devTunnel.issueToken")(function* () {
        yield* requireEnvironmentScope(AuthAccessWriteScope);
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        );
        return yield* tunnel.issueConnectToken();
      }),
    );
  }),
);

export const layerAuthPage = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const digest = yield* Digest.Digest;
    const hash = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(devTunnelAuthScript))
      .pipe(Effect.orDie);
    yield* router.add(
      "GET",
      "/auth/dev-tunnel",
      HttpServerResponse.text(devTunnelAuthHtml, {
        contentType: "text/html",
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'none'; script-src 'sha256-${Base64.encode(hash)}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
        },
      }),
    );
  }),
);

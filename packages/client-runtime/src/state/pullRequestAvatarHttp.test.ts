import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentPullRequestAvatar } from "./pullRequestAvatarHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});
const PATH = "/api/pull-requests/azure-avatars/dev.azure.com/acme/descriptor/aad.person";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const prepared = (authorization: PreparedConnection["httpAuthorization"]): PreparedConnection => ({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: authorization,
  target: TARGET,
});

describe("fetchEnvironmentPullRequestAvatar", () => {
  it.effect("uses the prepared environment URL and bearer authorization", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const bytes = yield* fetchEnvironmentPullRequestAvatar({
        prepared: prepared({ _tag: "Bearer", token: "secret-token" }),
        path: PATH,
        signer: Option.none(),
      }).pipe(
        Effect.provide(
          remoteHttpClientLayer(((request, init) => {
            calls.push([request, init ?? {}]);
            return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
          }) satisfies typeof fetch),
        ),
      );

      expect([...bytes]).toEqual([...PNG]);
      expect(String(calls[0]?.[0])).toBe(`https://environment.example.test${PATH}`);
      expect(new Headers(calls[0]?.[1].headers).get("authorization")).toBe("Bearer secret-token");
    }),
  );

  it.effect("rejects a non-image response and an oversized advertised response", () =>
    Effect.gen(function* () {
      const run = (headers: HeadersInit) =>
        fetchEnvironmentPullRequestAvatar({
          prepared: prepared(null),
          path: PATH,
          signer: Option.none(),
        }).pipe(
          Effect.provide(
            remoteHttpClientLayer((() =>
              Promise.resolve(new Response(PNG, { headers }))) satisfies typeof fetch),
          ),
          Effect.flip,
        );

      const wrongType = yield* run({ "content-type": "text/html" });
      const tooLarge = yield* run({
        "content-type": "image/png",
        "content-length": String(256 * 1024 + 1),
      });

      expect(wrongType.message).toContain("unsupported avatar content type");
      expect(tooLarge.message).toContain("too large");
    }),
  );
});

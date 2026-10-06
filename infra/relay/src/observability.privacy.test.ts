import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import * as Observability from "./observability.ts";

it.effect("does not initialize or export worker telemetry when the fork policy disables it", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.logInfo("private relay operation").pipe(
        Effect.withSpan("relay.private"),
        Effect.provide(Observability.layerTelemetry),
        Effect.provideService(Alchemy.Stack, {
          name: "privacy-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Axiom.Providers, {
          kind: "ProviderCollection",
          get: () => undefined,
          providers: {},
        }),
      ),
    );
    assert.strictEqual(fetchFn.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );
});

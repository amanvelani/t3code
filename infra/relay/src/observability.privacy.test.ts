import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import * as Observability from "./observability.ts";

it.effect("does not export relay worker traces with a configured collector", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.logInfo("private relay operation").pipe(
        Effect.withSpan("relay.private"),
        Effect.provide(
          Observability.layer({
            tracesEndpoint: "https://collector.example/v1/traces",
            tracesDatasetName: "traces",
            ingestToken: Redacted.make("test-token"),
          }),
        ),
      ),
    );
    assert.strictEqual(fetchFn.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );
});

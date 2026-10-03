import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as OtelEnvironment from "./otelEnvironment.ts";
import {
  makeRelayClientTracingLayer,
  RelayClientTracer,
  withRelayClientTracing,
} from "./relayTracing.ts";

it.effect("rejects environment, bootstrap and saved telemetry endpoints for every signal", () =>
  Effect.gen(function* () {
    const otel = yield* OtelEnvironment.load;
    for (const signal of ["traces", "metrics", "logs"] as const) {
      const ownExport = {
        protocol: "http/json" as const,
        exportIntervalMs: 10,
        headers: undefined,
      };
      for (const url of [undefined, "https://explicit.example/v1/" + signal]) {
        assert.isUndefined(
          OtelEnvironment.resolveSignalEndpoint(
            otel,
            signal,
            { url, export: ownExport },
            "https://bootstrap.example/",
            "https://settings.example/",
          ),
        );
      }
    }
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_OTEL_SDK_DISABLED: "false",
            OTEL_SDK_DISABLED: "false",
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/",
          },
        }),
      ),
    ),
  ),
);

it.effect("does not create or flush a relay exporter even with valid credentials", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const tracing = makeRelayClientTracingLayer(
    {
      tracesUrl: "https://collector.example/v1/traces",
      tracesDataset: "traces",
      tracesToken: "test-token",
    },
    { serviceName: "privacy-test", runtime: "test", client: "test" },
  );
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* RelayClientTracer));
        yield* Effect.void.pipe(Effect.withSpan("private-operation"), withRelayClientTracing);
      }).pipe(Effect.provide(tracing)),
    );
    assert.strictEqual(fetchFn.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as MobileTelemetry from "./MobileTelemetry.ts";

it.effect("rejects mobile telemetry without forwarding when network telemetry is disabled", () =>
  Effect.gen(function* () {
    const service = yield* MobileTelemetry.MobileTelemetry;
    const response = yield* service.handle(
      HttpServerRequest.fromWeb(new Request("https://relay.test/", { method: "POST", body: "{}" })),
      { projectId: "test", signal: "logs" },
    );
    assert.strictEqual(response.status, 503);
  }).pipe(
    Effect.provide(
      MobileTelemetry.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(MobileTelemetry.MobileTelemetrySettings, {
              axiomToken: Redacted.make("test"),
              destinations: {
                logs: { url: "https://example.test", dataset: "logs" },
                metrics: { url: "https://example.test", dataset: "metrics" },
                traces: { url: "https://example.test", dataset: "traces" },
              },
            }),
            Layer.succeed(MobileTelemetry.MobileTelemetryRateLimiter, {
              allow: () => Effect.succeed(true),
            }),
            Layer.succeed(MobileTelemetry.SourceMaps, {
              find: () => Effect.succeed("source_map_missing" as const),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unexpected export")),
            ),
          ),
        ),
      ),
    ),
  ),
);

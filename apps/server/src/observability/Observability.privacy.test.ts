import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { OtlpSerialization, type OtlpTracer } from "effect/observability";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";
import * as Observability from "./Observability.ts";

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({
    ...config,
    logLevel: "Info" as const,
    otlpTracesUrl: "https://collector.example/v1/traces",
    otlpMetricsUrl: "https://collector.example/v1/metrics",
    otlpLogsUrl: "https://collector.example/v1/logs",
  })),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-privacy-" })));

const layerCollector = (requests: string[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

it.effect("keeps server traces, metrics and logs local even with configured export URLs", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      yield* Metric.update(Metric.counter("privacy-test.counter"), 1);
      yield* Effect.logInfo("server log stays local");
    }).pipe(
      Effect.withSpan("server.private-operation"),
      Effect.provide(
        Observability.layer.pipe(
          Layer.provide(ResourceAttribution.layer),
          Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
          Layer.provide(layerCollector(requests)),
        ),
      ),
    );
    assert.deepEqual(requests, []);
    assert.include(yield* fs.readFileString(config.serverTracePath), "server.private-operation");
    assert.include(yield* fs.readFileString(config.serverTracePath), "server log stays local");
  }).pipe(Effect.scoped, Effect.provide(layerConfig.pipe(Layer.provideMerge(NodeServices.layer))));
});

it("records incoming browser traces locally without forwarding them to a collector", async () => {
  const requests: string[] = [];
  const records: unknown[] = [];
  const layerApp = ServerHttp.layerOtlpTracesProxyRoute.pipe(
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(layerCollector(requests)),
    Layer.provideMerge(OtlpSerialization.layerJson),
    Layer.provideMerge(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("privacy-test"),
            subject: "privacy-test",
            method: "bearer-access-token",
            scopes: [AuthOrchestrationOperateScope],
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(BrowserTraceCollector.BrowserTraceCollector, {
        record: (incoming) => Effect.sync(() => records.push(...incoming)).pipe(Effect.asVoid),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
  try {
    const response = await handler(
      new Request("http://localhost/api/observability/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: [], droppedAttributesCount: 0 },
              scopeSpans: [
                {
                  scope: { name: "effect" },
                  spans: [
                    {
                      traceId: "0123456789abcdef0123456789abcdef",
                      spanId: "0123456789abcdef",
                      parentSpanId: undefined,
                      name: "browser.private-operation",
                      kind: 1,
                      startTimeUnixNano: "1000000000",
                      endTimeUnixNano: "2000000000",
                      attributes: [],
                      droppedAttributesCount: 0,
                      events: [],
                      droppedEventsCount: 0,
                      links: [],
                      droppedLinksCount: 0,
                      status: { code: 1 },
                    },
                  ],
                },
              ],
            },
          ],
        } satisfies OtlpTracer.TraceData),
      }),
    );
    assert.equal(response.status, 204);
    assert.lengthOf(records, 1);
  } finally {
    await dispose();
  }
  assert.deepEqual(requests, []);
});

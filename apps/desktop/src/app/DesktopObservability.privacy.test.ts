import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const environmentInput = (baseDir: string) =>
  ({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }) satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  baseDir: string,
  isDevelopment = true,
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  DesktopEnvironment.layer(environmentInput(baseDir)).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          VITE_DEV_SERVER_URL: isDevelopment ? "http://127.0.0.1:5733" : undefined,
          ...env,
        }),
      ),
    ),
  );

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers every export with a 200 and keeps what was posted for assertions. */
const collectorLayer = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

// A developer's own OTEL_* variables would otherwise pick the endpoints.

const encodeObservabilitySettingsFile = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ observability: Schema.Record(Schema.String, Schema.String) }),
  ),
);

const writeObservabilitySettings = Effect.fn(function* (
  environmentLayer: ReturnType<typeof makeEnvironmentLayer>,
  observability: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const { path, serverSettingsPath } = yield* Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment;
  }).pipe(Effect.provide(environmentLayer));
  yield* fileSystem.makeDirectory(path.dirname(serverSettingsPath), { recursive: true });
  yield* fileSystem.writeFileString(
    serverSettingsPath,
    encodeObservabilitySettingsFile({ observability }),
  );
});

it.effect("keeps logs local despite saved endpoints and explicit environment opt-in", () => {
  const requests: Array<ExportedRequest> = [];
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-observability-test-",
    });
    const environmentLayer = makeEnvironmentLayer(baseDir);
    yield* writeObservabilitySettings(environmentLayer, {
      otlpTracesUrl: "https://settings.example.com/v1/traces",
      otlpLogsUrl: "https://settings.example.com/v1/logs",
    });

    yield* Effect.scoped(
      Effect.logInfo("desktop log stays local when disabled").pipe(
        Effect.withSpan("desktop-disabled-test"),
        Effect.provide(DesktopObservability.layer.pipe(Layer.provideMerge(environmentLayer))),
      ),
    );

    assert.lengthOf(requests, 0);
    const tracePath = yield* Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return environment.path.join(environment.logDir, "desktop.trace.ndjson");
    }).pipe(Effect.provide(environmentLayer));
    const trace = yield* fileSystem.readFileString(tracePath);
    assert.include(trace, "desktop-disabled-test");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        collectorLayer(requests),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              OTEL_SDK_DISABLED: "false",
              T3CODE_OTEL_SDK_DISABLED: "false",
              OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
            },
          }),
        ),
      ),
    ),
  );
});

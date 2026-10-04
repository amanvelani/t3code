import { DevTunnelError, type DevTunnelState } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerActivation from "../serverActivation.ts";

const PersistedConfig = Schema.Struct({
  enabled: Schema.Boolean,
  tunnelId: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
});
const configJson = Schema.fromJsonString(PersistedConfig);
const decodeConfig = Schema.decodeUnknownEffect(configJson);
const encodeConfig = Schema.encodeEffect(configJson);

export class DevTunnel extends Context.Service<
  DevTunnel,
  {
    readonly changes: Stream.Stream<DevTunnelState>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<DevTunnelState, DevTunnelError>;
  }
>()("t3/environment/DevTunnel") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const server = yield* HttpServer.HttpServer;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const binary = yield* Config.String("T3CODE_DEVTUNNEL_PATH").pipe(
    Config.withDefault("devtunnel"),
  );
  const configPath = path.join(serverConfig.stateDir, "dev-tunnel.json");
  const urlPath = path.join(serverConfig.stateDir, "dev-tunnel-url");
  const loaded = yield* fs.readFileString(configPath).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed('{"enabled":false}'),
    ),
    Effect.flatMap(decodeConfig),
    Effect.mapError((cause) => new DevTunnelError({ reason: "configuration", cause })),
    Effect.result,
  );
  let persisted: typeof PersistedConfig.Type =
    loaded._tag === "Success" ? loaded.success : { enabled: false };
  const loadError = loaded._tag === "Failure" ? loaded.failure : null;
  const state = yield* SubscriptionRef.make<DevTunnelState>({
    enabled: persisted.enabled,
    status: loadError ? "failed" : "stopped",
    url: null,
    error: loadError?.message ?? null,
  });
  const lock = yield* Semaphore.make(1);
  let active: Scope.Closeable | undefined;
  const clearUrl = fs.remove(urlPath, { force: true }).pipe(Effect.ignore);

  const persist = (next: typeof PersistedConfig.Type) =>
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({ directory: serverConfig.stateDir });
      const json = yield* encodeConfig(next);
      yield* fs.writeFileString(temporary, json);
      yield* fs.rename(temporary, configPath);
      persisted = next;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => new DevTunnelError({ reason: "configuration", cause })),
    );

  const run = (args: ReadonlyArray<string>) =>
    runner.run({ command: binary, args, timeout: "30 seconds", maxOutputBytes: 64 * 1024 }).pipe(
      Effect.mapError(
        (cause) =>
          new DevTunnelError({
            reason: cause._tag === "ProcessSpawnError" ? "not-installed" : "start-failed",
            cause,
          }),
      ),
    );

  const stop = Effect.gen(function* () {
    const childScope = active;
    active = undefined;
    if (childScope) yield* Scope.close(childScope, Exit.void);
    yield* clearUrl;
  });
  yield* Effect.addFinalizer(() => stop);

  const setEnabled = (enabled: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (loadError) return yield* loadError;
        const current = yield* SubscriptionRef.get(state);
        if (!enabled) {
          yield* persist({ ...persisted, enabled: false });
          yield* stop;
          const next: DevTunnelState = {
            enabled: false,
            status: "stopped",
            url: null,
            error: null,
          };
          yield* SubscriptionRef.set(state, next);
          return next;
        }
        if (current.status === "running") return current;
        yield* stop;
        yield* SubscriptionRef.set(state, {
          enabled: true,
          status: "starting",
          url: null,
          error: null,
        });
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const login = yield* run(["user", "show"]);
            if (login.code !== 0 || /not logged in/i.test(login.stdout)) {
              return yield* new DevTunnelError({ reason: "login-required" });
            }
            const address = server.address;
            const port = serverConfig.devUrl
              ? Number(
                  serverConfig.devUrl.port ||
                    (serverConfig.devUrl.protocol === "https:" ? 443 : 80),
                )
              : typeof address === "object" && "port" in address
                ? address.port
                : 0;
            if (port === 0 || serverConfig.devUrl?.protocol === "https:") {
              return yield* new DevTunnelError({ reason: "configuration" });
            }
            let tunnelId = persisted.tunnelId;
            if (!tunnelId) {
              const uuid = yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) => new DevTunnelError({ reason: "configuration", cause })),
              );
              tunnelId = `t3${uuid.replaceAll("-", "").slice(0, 20)}`;
              const created = yield* run(["create", tunnelId, "--expiration", "30d"]);
              if (created.code !== 0) return yield* new DevTunnelError({ reason: "start-failed" });
              yield* persist({ enabled: false, tunnelId });
            }
            // Reconcile the port after a server restart or a dev-runner port shift.
            if (persisted.port !== port) {
              if (persisted.port !== undefined) {
                const removed = yield* run([
                  "port",
                  "delete",
                  tunnelId,
                  "-p",
                  String(persisted.port),
                ]);
                if (removed.code !== 0)
                  return yield* new DevTunnelError({ reason: "start-failed" });
                yield* persist({ enabled: false, tunnelId });
              }
              const configured = yield* run([
                "port",
                "create",
                tunnelId,
                "-p",
                String(port),
                "--protocol",
                "http",
              ]);
              if (configured.code !== 0)
                return yield* new DevTunnelError({ reason: "start-failed" });
            }
            yield* persist({ enabled: true, tunnelId, port });
            const ready = yield* Deferred.make<string, DevTunnelError>();
            const childScope = yield* Scope.make();
            active = childScope;
            const fail = (cause: unknown) =>
              Effect.gen(function* () {
                if (active !== childScope) return;
                const error = new DevTunnelError({ reason: "start-failed", cause });
                yield* clearUrl;
                yield* SubscriptionRef.set(state, {
                  enabled: true,
                  status: "failed",
                  url: null,
                  error: error.message,
                });
                yield* Deferred.fail(ready, error);
              });
            yield* Effect.forkIn(
              Effect.gen(function* () {
                const child = yield* spawner
                  .spawn(
                    ChildProcess.make(binary, ["host", tunnelId], {
                      stdin: "ignore",
                      stdout: "pipe",
                      stderr: "pipe",
                    }),
                  )
                  .pipe(Effect.provideService(Scope.Scope, childScope));
                let url: string | undefined;
                let hostingPort = false;
                yield* child.stdout.pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.runForEach((line) =>
                    Effect.gen(function* () {
                      if (active !== childScope) return;
                      if (line.trim() === `Hosting port: ${port}`) hostingPort = true;
                      if (
                        line.startsWith(`Hosting port ${port} at `) ||
                        (hostingPort && line.startsWith("Connect via browser: "))
                      ) {
                        const candidates = line.match(/https:\/\/[^\s,]+/g) ?? [];
                        url = candidates.find((candidate) => {
                          const parsed = URL.parse(candidate);
                          return (
                            parsed?.protocol === "https:" &&
                            parsed.port === "" &&
                            parsed.hostname.endsWith(".devtunnels.ms")
                          );
                        });
                      }
                      if (url && line.startsWith("Ready to accept connections for tunnel:")) {
                        yield* fs.writeFileString(urlPath, url);
                        yield* SubscriptionRef.set(state, {
                          enabled: true,
                          status: "running",
                          url,
                          error: null,
                        });
                        yield* Deferred.succeed(ready, url);
                        yield* Effect.logInfo("Dev Tunnel ready", { url });
                      }
                    }),
                  ),
                  Effect.catchCause((cause) => fail(cause).pipe(Effect.andThen(child.kill()))),
                  (effect) => Effect.forkIn(effect, childScope),
                );
                yield* child.stderr.pipe(
                  Stream.runDrain,
                  Effect.catchCause((cause) => fail(cause).pipe(Effect.andThen(child.kill()))),
                  (effect) => Effect.forkIn(effect, childScope),
                );
                const exitCode = yield* child.exitCode;
                yield* fail(exitCode);
                if (active === childScope) {
                  active = undefined;
                  yield* Scope.close(childScope, Exit.void);
                }
              }).pipe(Effect.catchCause(fail)),
              scope,
            );
            yield* Deferred.await(ready).pipe(
              Effect.timeout("45 seconds"),
              Effect.mapError((cause) => new DevTunnelError({ reason: "start-failed", cause })),
            );
            return yield* SubscriptionRef.get(state);
          }),
        );
        if (result._tag === "Success") return result.success;
        yield* stop;
        yield* SubscriptionRef.set(state, {
          enabled: persisted.enabled,
          status: "failed",
          url: null,
          error: result.failure.message,
        });
        return yield* result.failure;
      }).pipe(
        Effect.onInterrupt(() =>
          stop.pipe(
            Effect.andThen(
              SubscriptionRef.set(state, {
                enabled: persisted.enabled,
                status: "failed",
                url: null,
                error: "Dev Tunnel startup was interrupted. Retry to reconnect.",
              }),
            ),
          ),
        ),
      ),
    );

  yield* ServerActivation.forkParked(
    persisted.enabled || serverConfig.devTunnelEnabled
      ? setEnabled(true).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Dev Tunnel startup failed", {
              reason: error.reason,
              message: error.message,
            }),
          ),
        )
      : clearUrl,
  );
  return DevTunnel.of({ changes: SubscriptionRef.changes(state), setEnabled });
});

export const layer = Layer.effect(DevTunnel, make).pipe(Layer.provide(ProcessRunner.layer));

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DevTunnel from "./DevTunnel.ts";

const setup = (
  options: {
    loggedIn?: boolean;
    hostFails?: boolean;
    corrupt?: boolean;
    missingBinary?: boolean;
    currentCliOutput?: boolean;
    waitForReady?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "dev-tunnel-test-" }),
    );
    const config = yield* Effect.service(ServerConfig.ServerConfig).pipe(Effect.provide(context));
    const calls: Array<ReadonlyArray<string>> = [];
    let stops = 0;
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const hostStarted = yield* Deferred.make<void>();
    if (options.corrupt)
      yield* fs.writeFileString(path.join(config.stateDir, "dev-tunnel.json"), "invalid");
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        options.missingBinary
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "devtunnel",
                argumentCount: args.length,
                cause: "ENOENT",
              }),
            )
          : Effect.sync(() => {
              calls.push(args);
              return {
                stdout: options.loggedIn === false ? "Not logged in." : "Logged in.",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
    });
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      calls.push(command.args);
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: options.hostFails
          ? Effect.succeed(ChildProcessSpawner.ExitCode(1))
          : Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () =>
          Effect.sync(() => {
            stops++;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: options.hostFails
          ? Stream.empty
          : options.waitForReady
            ? Stream.fromEffect(Deferred.succeed(hostStarted, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
              )
            : (options.currentCliOutput
                ? Stream.make(
                    "Connection to host tunnel relay restored.\nHosting port: 3773\nConnect via browser: https://example-3773.usw2.dev",
                    "tunnels.ms\nInspect network activity: https://example-3773-inspect.usw2.devtunnels.ms\n\nReady to accept connections for tunnel: example\n",
                  )
                : Stream.make(
                    "Hosting port 3773 at https://example.usw2.devtunnels.ms:3773/, https://example-3773.usw2.dev",
                    "tunnels.ms/\nReady to accept connections for tunnel: example\n",
                  )
              ).pipe(Stream.encodeText),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      return Effect.acquireRelease(Effect.succeed(handle), () => handle.kill().pipe(Effect.orDie));
    });
    const make = DevTunnel.make.pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.make({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
          serve: () => Effect.void,
        }),
      ),
    );
    const service = yield* make;
    return { service, make, fs, path, config, calls, exited, hostStarted, stops: () => stops };
  });

describe("Dev Tunnels", () => {
  it.effect("stops its host when startup is interrupted and allows a retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup({ waitForReady: true });
        const starting = yield* h.service.setEnabled(true).pipe(Effect.forkChild);
        yield* Deferred.await(h.hostStarted);
        yield* Fiber.interrupt(starting);
        expect(h.stops()).toBe(1);
        const states = yield* h.service.changes.pipe(Stream.take(1), Stream.runCollect);
        expect(states[0]).toMatchObject({ enabled: true, status: "failed", url: null });
        expect(yield* h.fs.exists(h.path.join(h.config.stateDir, "dev-tunnel-url"))).toBe(false);
        expect(yield* h.service.setEnabled(false)).toMatchObject({ status: "stopped" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("reads the browser URL from current CLI output without selecting the inspector", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup({ currentCliOutput: true });
        expect((yield* h.service.setEnabled(true)).url).toBe(
          "https://example-3773.usw2.devtunnels.ms",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("hosts privately, parses split output, and stops only its own child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup();
        const running = yield* h.service.setEnabled(true);
        expect(running).toMatchObject({
          enabled: true,
          status: "running",
          url: "https://example-3773.usw2.devtunnels.ms/",
        });
        expect(h.calls.some((args) => args.includes("--allow-anonymous"))).toBe(false);
        expect(yield* h.fs.readFileString(h.path.join(h.config.stateDir, "dev-tunnel-url"))).toBe(
          running.url,
        );
        expect(yield* h.service.setEnabled(false)).toMatchObject({
          enabled: false,
          status: "stopped",
          url: null,
        });
        expect(h.stops()).toBe(1);
        expect(yield* h.fs.exists(h.path.join(h.config.stateDir, "dev-tunnel-url"))).toBe(false);
        yield* h.service.setEnabled(true);
        expect(h.calls.filter((args) => args[0] === "create")).toHaveLength(1);
        expect(h.calls.filter((args) => args[0] === "port" && args[1] === "create")).toHaveLength(
          1,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses the persisted tunnel and automatically resumes after a server restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* h.make;
            yield* first.setEnabled(true);
          }),
        );
        const restarted = yield* h.make;
        const running = yield* restarted.changes.pipe(
          Stream.filter((state) => state.status === "running"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(running[0]?.url).toBe("https://example-3773.usw2.devtunnels.ms/");
        expect(h.calls.filter((args) => args[0] === "create")).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires account login before creating or hosting a tunnel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup({ loggedIn: false });
        const result = yield* Effect.result(h.service.setEnabled(true));
        expect(result._tag === "Failure" && result.failure.reason).toBe("login-required");
        expect(h.calls).toEqual([["user", "show"]]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces early host failure and releases the process without a timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup({ hostFails: true });
        const result = yield* Effect.result(h.service.setEnabled(true));
        expect(result._tag === "Failure" && result.failure.reason).toBe("start-failed");
        expect(h.stops()).toBe(1);
        expect(yield* h.fs.exists(h.path.join(h.config.stateDir, "dev-tunnel-url"))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves corrupt configuration instead of silently replacing the tunnel identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* setup({ corrupt: true });
          const result = yield* Effect.result(h.service.setEnabled(true));
          expect(result._tag === "Failure" && result.failure.reason).toBe("configuration");
          expect(h.calls).toEqual([]);
          expect(
            yield* h.fs.readFileString(h.path.join(h.config.stateDir, "dev-tunnel.json")),
          ).toBe("invalid");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing CLI before making any tunnel changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup({ missingBinary: true });
        const result = yield* Effect.result(h.service.setEnabled(true));
        expect(result._tag === "Failure" && result.failure.reason).toBe("not-installed");
        expect(h.calls).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes a disconnected state and clears the URL if the host exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.service.setEnabled(true);
        const failed = yield* h.service.changes.pipe(
          Stream.filter((state) => state.status === "failed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.succeed(h.exited, ChildProcessSpawner.ExitCode(1));
        expect((yield* Fiber.join(failed))[0]).toMatchObject({
          enabled: true,
          status: "failed",
          url: null,
        });
        expect(yield* h.fs.exists(h.path.join(h.config.stateDir, "dev-tunnel-url"))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

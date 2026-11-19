import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import * as Tracer from "effect/Tracer";
// Load the runtime's module graph once at collection, outside the per-test timeout;
// each case re-evaluates it from that cache after vi.resetModules().
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const answers = (...values: Array<boolean | null>) => {
  let call = 0;
  return () => values[Math.min(call++, values.length - 1)] ?? null;
};

describe("web runtime relay telemetry policy", () => {
  it.each([
    {
      surface: "desktop opt-out",
      desktopBridge: { getRelayTelemetryEnabled: () => false },
    },
    {
      surface: "desktop enabled",
      desktopBridge: { getRelayTelemetryEnabled: () => true },
    },
    {
      // The desktop host reads the login shell after the renderer has started.
      surface: "desktop enabled once the login shell is read",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, true) },
    },
    {
      surface: "desktop opt-out found in the login shell",
      desktopBridge: { getRelayTelemetryEnabled: answers(null, false, true) },
    },
    {
      surface: "ordinary browser",
      desktopBridge: undefined,
    },
  ])("applies $surface before the first relay span", async ({ desktopBridge }) => {
    vi.resetModules();
    vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "false");
    vi.stubEnv("T3CODE_OTEL_SDK_DISABLED", "true");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubGlobal("window", { desktopBridge });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);
    // Re-import after setting runtime policy: static initialization creates the exporter layer.
    const { runtime: freshRuntime } = await import("./runtime");
    const { setDelegate } = await import("../observability/clientTracer");
    const userSpans: Array<string> = [];

    try {
      expect(
        await freshRuntime.runPromise(
          Effect.succeed("relay operation completed").pipe(
            Effect.withSpan("relay.first-operation"),
            withRelayClientTracing,
          ),
        ),
      ).toBe("relay operation completed");

      setDelegate(
        Tracer.make({
          span(options) {
            userSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      await freshRuntime.runPromise(Effect.void.pipe(Effect.withSpan("user.work")));
      expect(userSpans).toEqual(["user.work"]);
    } finally {
      setDelegate(null);
      // Closing the runtime flushes the exporter without waiting for its batch timer.
      await freshRuntime.dispose();
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("web runtime WebSocketConstructor", () => {
  it.effect("allows options objects in desktop by delegating headers to main process", () =>
    Effect.gen(function* () {
      class MockWebSocket {
        constructor(
          public url: string,
          public protocols?: unknown,
        ) {}
      }
      vi.stubGlobal("WebSocket", MockWebSocket);
      vi.stubGlobal("window", { desktopBridge: {} });
      const { layerWebSocketConstructor } = yield* Effect.promise(() => import("./runtime"));
      const wsConstructor = yield* Socket.WebSocketConstructor.pipe(
        Effect.provide(layerWebSocketConstructor),
      );

      const ws = wsConstructor("wss://test.devtunnels.ms/ws", {
        headers: { "X-Tunnel-Authorization": "tunnel token123" },
        protocols: "chat",
      } as any);
      expect(ws).toBeInstanceOf(MockWebSocket);
      expect((ws as any).protocols).toBe("chat");
    }),
  );

  it.effect("rejects options objects in ordinary browser runtime", () =>
    Effect.gen(function* () {
      class MockWebSocket {
        constructor(
          public url: string,
          public protocols?: unknown,
        ) {}
      }
      vi.stubGlobal("WebSocket", MockWebSocket);
      vi.stubGlobal("window", {});
      const { layerWebSocketConstructor } = yield* Effect.promise(() => import("./runtime"));
      const wsConstructor = yield* Socket.WebSocketConstructor.pipe(
        Effect.provide(layerWebSocketConstructor),
      );

      expect(() =>
        wsConstructor("wss://test.devtunnels.ms/ws", {
          headers: { "X-Tunnel-Authorization": "tunnel token123" },
        } as any),
      ).toThrow(TypeError);

      const ws = wsConstructor("wss://test.devtunnels.ms/ws", "chat");
      expect(ws).toBeInstanceOf(MockWebSocket);
    }),
  );
});

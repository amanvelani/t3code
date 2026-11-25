import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import {
  extractExactSecureOrigins,
  makeWithSession,
  parseTunnelTokensFromCatalog,
  type DevTunnelSessionLike,
} from "./DesktopDevTunnelInterceptor.ts";

type HeaderListener = Exclude<
  Parameters<NonNullable<DevTunnelSessionLike["webRequest"]>["onBeforeSendHeaders"]>[0],
  null
>;

vi.mock("electron", () => ({
  session: {
    get defaultSession() {
      throw new Error("Default session is unavailable before app readiness.");
    },
  },
}));

describe("DesktopDevTunnelInterceptor", () => {
  it.effect("can initialize and dispose before Electron is ready", () =>
    Effect.gen(function* () {
      const interceptor = yield* makeWithSession();
      yield* interceptor.updateCatalog(null);
      yield* interceptor.dispose;
    }),
  );

  it("extracts exact secure origins and their ws equivalents", () => {
    const origins = extractExactSecureOrigins(
      "https://test-4000.asse.devtunnels.ms",
      "wss://test-4000.asse.devtunnels.ms",
    );
    assert.deepStrictEqual(
      new Set(origins),
      new Set(["https://test-4000.asse.devtunnels.ms", "wss://test-4000.asse.devtunnels.ms"]),
    );

    // Insecure origins are ignored
    const insecureOrigins = extractExactSecureOrigins(
      "http://insecure.example.com",
      "ws://insecure.example.com",
    );
    assert.strictEqual(insecureOrigins.length, 0);
  });

  it("parses tunnel tokens from catalog, respecting disabled and forgotten credentials", () => {
    const catalog = JSON.stringify({
      schemaVersion: 1,
      targets: [],
      remoteDpopTokens: [],
      profiles: [
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:env-1",
          environmentId: "env-1",
          label: "Env 1",
          httpBaseUrl: "https://tunnel-1.asse.devtunnels.ms",
          wsBaseUrl: "wss://tunnel-1.asse.devtunnels.ms",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:env-2",
          environmentId: "env-2",
          label: "Env 2",
          httpBaseUrl: "https://tunnel-2.asse.devtunnels.ms",
          wsBaseUrl: "wss://tunnel-2.asse.devtunnels.ms",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:env-3",
          environmentId: "env-3",
          label: "Env 3",
          httpBaseUrl: "https://tunnel-3.asse.devtunnels.ms",
          wsBaseUrl: "wss://tunnel-3.asse.devtunnels.ms",
        },
      ],
      credentials: [
        {
          connectionId: "bearer:env-1",
          credential: {
            _tag: "BearerConnectionCredential",
            token: "t3-token-1",
            tunnelToken: "tunnel-token-1",
          },
        },
        {
          // Disabled environment
          connectionId: "bearer:env-2",
          credential: {
            _tag: "BearerConnectionCredential",
            token: "t3-token-2",
            tunnelToken: "tunnel-token-2",
          },
        },
        {
          // Forgotten profile (no matching profile)
          connectionId: "bearer:unknown",
          credential: {
            _tag: "BearerConnectionCredential",
            token: "t3-token-x",
            tunnelToken: "tunnel-token-x",
          },
        },
        {
          // No tunnelToken
          connectionId: "bearer:env-3",
          credential: {
            _tag: "BearerConnectionCredential",
            token: "t3-token-3",
          },
        },
      ],
      disabledEnvironmentIds: ["env-2"],
    });

    const tokens = parseTunnelTokensFromCatalog(catalog);
    assert.strictEqual(tokens.get("https://tunnel-1.asse.devtunnels.ms"), "tunnel-token-1");
    assert.strictEqual(tokens.get("wss://tunnel-1.asse.devtunnels.ms"), "tunnel-token-1");

    // Disabled env-2 is not present
    assert.strictEqual(tokens.get("https://tunnel-2.asse.devtunnels.ms"), undefined);
    // Forgotten connection is not present
    assert.strictEqual(tokens.size, 2);
  });

  it.effect(
    "intercepts requests with exact origin matching and injects X-Tunnel-Authorization",
    () =>
      Effect.gen(function* () {
        let registeredListener: HeaderListener | null = null;
        const mockSession = {
          webRequest: {
            onBeforeSendHeaders: vi.fn((listener: HeaderListener | null) => {
              registeredListener = listener;
            }),
          },
        };

        const interceptor = yield* makeWithSession(mockSession);
        assert.isNull(registeredListener);
        const invokeListener = (details: Parameters<HeaderListener>[0]) => {
          let headers: Electron.BeforeSendResponse["requestHeaders"];
          if (!registeredListener) throw new Error("Listener was not registered.");
          registeredListener(details, (res) => {
            headers = res.requestHeaders;
          });
          return headers;
        };

        const catalog = JSON.stringify({
          schemaVersion: 1,
          targets: [],
          remoteDpopTokens: [],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              label: "One",
              connectionId: "conn-1",
              environmentId: "env-1",
              httpBaseUrl: "https://my-tunnel.asse.devtunnels.ms",
              wsBaseUrl: "wss://my-tunnel.asse.devtunnels.ms",
            },
          ],
          credentials: [
            {
              connectionId: "conn-1",
              credential: {
                _tag: "BearerConnectionCredential",
                token: "t3-token",
                tunnelToken: "secret-tunnel-token-123",
              },
            },
          ],
          disabledEnvironmentIds: [],
        });

        yield* interceptor.updateCatalog(catalog);
        yield* interceptor.start;
        yield* interceptor.start;
        assert.strictEqual(mockSession.webRequest.onBeforeSendHeaders.mock.calls.length, 1);
        assert.ok(registeredListener);

        yield* interceptor.setMainWindowPolicy({
          desktopOrigin: "t3code://app",
          mainWebContentsId: 42,
          isDevelopment: false,
        });

        assert.deepStrictEqual(
          invokeListener({
            url: "https://my-tunnel.asse.devtunnels.ms/.well-known/t3/environment",
            webContentsId: 42,
            frame: { parent: null },
            requestHeaders: {
              Origin: "t3code://app",
              "x-tunnel-authorization": "tunnel fresh-pairing-token",
            },
          }),
          {
            Origin: "t3code://app",
            "x-tunnel-authorization": "tunnel fresh-pairing-token",
          },
        );

        // 1. Matching HTTPS request (e.g. image, video, fetch)
        assert.deepStrictEqual(
          invokeListener({
            url: "https://my-tunnel.asse.devtunnels.ms/media/screenshot.png",
            webContentsId: 42,
            frame: { parent: null },
            requestHeaders: { "User-Agent": "TestAgent", Origin: "t3code://app" },
          }),
          {
            "User-Agent": "TestAgent",
            Origin: "t3code://app",
            "X-Tunnel-Authorization": "tunnel secret-tunnel-token-123",
          },
        );

        // 2. Matching WebSocket upgrade request (wss)
        assert.deepStrictEqual(
          invokeListener({
            url: "wss://my-tunnel.asse.devtunnels.ms/ws",
            webContentsId: 42,
            frame: null,
            requestHeaders: { Origin: "t3code://app" },
          }),
          {
            "X-Tunnel-Authorization": "tunnel secret-tunnel-token-123",
            Origin: "t3code://app",
          },
        );

        // 3. Different subdomain / wildcard check: no wildcard sharing
        assert.deepStrictEqual(
          invokeListener({
            url: "https://other-tunnel.asse.devtunnels.ms/media/screenshot.png",
            requestHeaders: { "User-Agent": "TestAgent" },
          }),
          { "User-Agent": "TestAgent" },
        );

        // 4. Insecure HTTP request is not matched
        assert.deepStrictEqual(
          invokeListener({
            url: "http://my-tunnel.asse.devtunnels.ms/api",
            requestHeaders: {},
          }),
          {},
        );

        // 5. Unrelated website
        assert.deepStrictEqual(
          invokeListener({
            url: "https://github.com/api",
            webContentsId: 42,
            frame: { parent: null },
            requestHeaders: {
              Accept: "application/json",
              Origin: "t3code://app",
              "Sec-Fetch-Mode": "cors",
              "X-Tunnel-Authorization": "tunnel must-not-leak",
            },
          }),
          { Accept: "application/json" },
        );

        yield* interceptor.setMainWindowPolicy(undefined);
        assert.deepStrictEqual(
          invokeListener({
            url: "https://github.com/api",
            webContentsId: 42,
            requestHeaders: { Origin: "t3code://app" },
          }),
          { Origin: "t3code://app" },
        );
        assert.strictEqual(mockSession.webRequest.onBeforeSendHeaders.mock.calls.length, 1);

        // 6. When catalog is updated with credential removed, origin is no longer intercepted
        yield* interceptor.updateCatalog(
          JSON.stringify({ schemaVersion: 1, profiles: [], credentials: [] }),
        );
        assert.deepStrictEqual(
          invokeListener({
            url: "https://my-tunnel.asse.devtunnels.ms/media/screenshot.png",
            requestHeaders: {},
          }),
          {},
        );

        // 7. Dispose unregisters the listener
        yield* interceptor.dispose;
        assert.strictEqual(mockSession.webRequest.onBeforeSendHeaders.mock.calls.at(-1)?.[0], null);
      }),
  );
});

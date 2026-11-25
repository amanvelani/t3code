import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { describe, expect, it } from "vite-plus/test";

import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("preserves tunnelToken passed as string", () => {
    expect(buildPairingUrl("my-tunnel.devtunnels.ms", "pairing-token", "tunnel-secret-123")).toBe(
      "https://my-tunnel.devtunnels.ms/#token=pairing-token&tunnelToken=tunnel-secret-123",
    );
  });

  it("preserves tunnelToken passed as options object", () => {
    expect(
      buildPairingUrl("my-tunnel.devtunnels.ms", "pairing-token", {
        tunnelToken: "tunnel-secret-456",
      }),
    ).toBe("https://my-tunnel.devtunnels.ms/#token=pairing-token&tunnelToken=tunnel-secret-456");
  });

  it("preserves tunnelToken already present in host hash", () => {
    expect(
      buildPairingUrl(
        "https://my-tunnel.devtunnels.ms/#tunnelToken=tunnel-secret-789",
        "pairing-token",
      ),
    ).toBe("https://my-tunnel.devtunnels.ms/#token=pairing-token&tunnelToken=tunnel-secret-789");
  });

  it("pairs with the address's own origin when the address carries a query", () => {
    const pairingUrl = buildPairingUrl(
      "https://remote.example.com/?host=https%3A%2F%2Fother.example.com",
      "pairing-token",
    );

    expect(pairingUrl).toBe("https://remote.example.com/#token=pairing-token");
    expect(resolveRemotePairingTarget({ pairingUrl })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links carrying token and tunnelToken", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fmy-tunnel.devtunnels.ms%23token%3Dtok%26tunnelToken%3Dtun",
      ),
    ).toBe("https://my-tunnel.devtunnels.ms#token=tok&tunnelToken=tun");
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });

  it("parses dev tunnel URL with token and tunnelToken in hash", () => {
    expect(
      parsePairingUrl(
        "https://my-tunnel.devtunnels.ms/#token=pairing-code-1&tunnelToken=tunnel-token-2",
      ),
    ).toEqual({
      host: "https://my-tunnel.devtunnels.ms",
      code: "pairing-code-1",
      tunnelToken: "tunnel-token-2",
    });
  });

  it("parses schemeless input with token and tunnelToken", () => {
    expect(parsePairingUrl("my-tunnel.devtunnels.ms#token=code-3&tunnelToken=token-4")).toEqual({
      host: "https://my-tunnel.devtunnels.ms",
      code: "code-3",
      tunnelToken: "token-4",
    });
  });
});

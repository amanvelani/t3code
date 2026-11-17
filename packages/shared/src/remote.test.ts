// @effect-diagnostics globalDate:off -- Tests exercise Date.now()
import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingAppLink,
  devTunnelRequestHeaders,
  isDevTunnelUrl,
  isTunnelTokenExpired,
  readPairingAppLink,
  RemoteBackendUrlMissingError,
  RemotePairingTokenMissingError,
  RemotePairingUrlInvalidError,
  resolveRemotePairingTarget,
} from "./remote.ts";

describe("remote", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives backend urls from hosted app pairing links", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "///example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//https://example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl: "ftp://remote.example.com/pair#token=pairing-token",
      });
    } catch (cause) {
      pairingUrlError = cause;
    }

    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect(pairingUrlError).toMatchObject({ protocol: "ftp:" });
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeUndefined();
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(RemoteBackendUrlMissingError);
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }),
    ).toThrowError(RemotePairingTokenMissingError);
    expect(() =>
      resolveRemotePairingTarget({
        host: "https://user:secret@remote.example.com/path?token=sensitive#fragment",
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "RemotePairingCodeMissingError",
        host: "remote.example.com",
      }),
    );
  });

  it("round-trips pairing urls through app links on every channel scheme", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const appLink = buildPairingAppLink(pairingUrl);
    expect(appLink.startsWith("t3code://pair?")).toBe(true);
    expect(readPairingAppLink(appLink)).toBe(pairingUrl);
    expect(readPairingAppLink(appLink.replace("t3code:", "t3code-dev:"))).toBe(pairingUrl);
    expect(readPairingAppLink("t3code://pair")).toBeNull();
    expect(readPairingAppLink(appLink.replace("//pair?", "//pair/other?"))).toBeNull();
    expect(
      readPairingAppLink(`t3code://threads?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
    expect(
      readPairingAppLink(`https://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
  });

  describe("Dev Tunnel credential transport", () => {
    it("preserves optional tunnelToken from pairing URL fragment parameter", () => {
      expect(
        resolveRemotePairingTarget({
          pairingUrl:
            "https://machine-3773.usw2.devtunnels.ms/pair#token=pairing-token&tunnelToken=tunnel-credential",
        }),
      ).toEqual({
        credential: "pairing-token",
        httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
        wsBaseUrl: "wss://machine-3773.usw2.devtunnels.ms/",
        tunnelToken: "tunnel-credential",
      });
    });

    it("preserves optional tunnelToken from explicit input", () => {
      expect(
        resolveRemotePairingTarget({
          pairingUrl: "https://machine-3773.usw2.devtunnels.ms/pair#token=pairing-token",
          tunnelToken: "explicit-token",
        }),
      ).toEqual({
        credential: "pairing-token",
        httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
        wsBaseUrl: "wss://machine-3773.usw2.devtunnels.ms/",
        tunnelToken: "explicit-token",
      });

      expect(
        resolveRemotePairingTarget({
          host: "https://machine-3773.usw2.devtunnels.ms",
          pairingCode: "pairing-token",
          tunnelToken: "explicit-token",
        }),
      ).toEqual({
        credential: "pairing-token",
        httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
        wsBaseUrl: "wss://machine-3773.usw2.devtunnels.ms/",
        tunnelToken: "explicit-token",
      });
    });

    it("never reads tunnelToken from query parameters", () => {
      expect(
        resolveRemotePairingTarget({
          pairingUrl:
            "https://machine-3773.usw2.devtunnels.ms/pair?tunnelToken=leaked-in-query#token=pairing-token",
        }),
      ).toEqual({
        credential: "pairing-token",
        httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
        wsBaseUrl: "wss://machine-3773.usw2.devtunnels.ms/",
      });
    });

    it("explicit tunnelToken input takes precedence over fragment parameter", () => {
      expect(
        resolveRemotePairingTarget({
          pairingUrl:
            "https://machine-3773.usw2.devtunnels.ms/pair#token=pairing-token&tunnelToken=frag-token",
          tunnelToken: "explicit-token",
        }),
      ).toEqual({
        credential: "pairing-token",
        httpBaseUrl: "https://machine-3773.usw2.devtunnels.ms/",
        wsBaseUrl: "wss://machine-3773.usw2.devtunnels.ms/",
        tunnelToken: "explicit-token",
      });
    });

    it("validates dev tunnel URLs strictly", () => {
      expect(isDevTunnelUrl("https://foo-3773.usw2.devtunnels.ms/")).toBe(true);
      expect(isDevTunnelUrl("wss://foo-3773.usw2.devtunnels.ms/ws")).toBe(true);
      // cleartext
      expect(isDevTunnelUrl("http://foo-3773.usw2.devtunnels.ms/")).toBe(false);
      expect(isDevTunnelUrl("ws://foo-3773.usw2.devtunnels.ms/ws")).toBe(false);
      // non-devtunnel
      expect(isDevTunnelUrl("https://example.com/")).toBe(false);
      expect(isDevTunnelUrl("https://devtunnels.ms/")).toBe(false);
      expect(isDevTunnelUrl("https://evil-devtunnels.ms/")).toBe(false);
      expect(isDevTunnelUrl("https://user:password@foo.usw2.devtunnels.ms/")).toBe(false);
      expect(isDevTunnelUrl("https://foo.usw2.devtunnels.ms:8443/")).toBe(false);
      for (const host of ["http://foo.usw2.devtunnels.ms", "https://unrelated.test"]) {
        expect(() =>
          resolveRemotePairingTarget({ host, pairingCode: "pairing-token", tunnelToken: "secret" }),
        ).toThrow();
        expect(() =>
          resolveRemotePairingTarget({
            pairingUrl: `${host}/pair#token=pairing-token&tunnelToken=secret`,
          }),
        ).toThrow();
      }
    });

    it("generates devTunnelRequestHeaders only for valid HTTPS dev tunnel origins", () => {
      expect(devTunnelRequestHeaders("https://foo-3773.usw2.devtunnels.ms/", "my-token")).toEqual({
        "X-Tunnel-Authorization": "tunnel my-token",
      });
      // Already has tunnel prefix
      expect(
        devTunnelRequestHeaders("https://foo-3773.usw2.devtunnels.ms/", "tunnel my-token"),
      ).toEqual({
        "X-Tunnel-Authorization": "tunnel my-token",
      });
      // Absent token
      expect(devTunnelRequestHeaders("https://foo-3773.usw2.devtunnels.ms/", undefined)).toEqual(
        {},
      );
      expect(devTunnelRequestHeaders("https://foo-3773.usw2.devtunnels.ms/", "")).toEqual({});
      // Non-devtunnel origin
      expect(devTunnelRequestHeaders("https://example.com/", "my-token")).toEqual({});
      // Cleartext
      expect(devTunnelRequestHeaders("http://foo-3773.usw2.devtunnels.ms/", "my-token")).toEqual(
        {},
      );
    });

    it("checks JWT tunnel token expiry for UX without rejecting malformed tokens", () => {
      const nowSec = 1_700_000_000;
      const expiredPayload = Buffer.from(JSON.stringify({ exp: nowSec - 60 })).toString(
        "base64url",
      );
      const activePayload = Buffer.from(JSON.stringify({ exp: nowSec + 3600 })).toString(
        "base64url",
      );
      const expiredJwt = `eyJhbGciOiJub25lIn0.${expiredPayload}.`;
      const activeJwt = `eyJhbGciOiJub25lIn0.${activePayload}.`;

      expect(isTunnelTokenExpired(expiredJwt, nowSec * 1000)).toBe(true);
      expect(isTunnelTokenExpired(activeJwt, nowSec * 1000)).toBe(false);
      expect(isTunnelTokenExpired("not-a-jwt", nowSec * 1000)).toBe(false);
      expect(isTunnelTokenExpired(undefined, nowSec * 1000)).toBe(false);
    });
  });
});

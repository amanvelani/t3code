import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearActiveDevTunnels,
  DEV_TUNNEL_HEADER,
  devTunnelHeaders,
  registerActiveDevTunnel,
} from "./devTunnelHeaders";

describe("devTunnelHeaders", () => {
  const env1 = EnvironmentId.make("env-1");
  const env2 = EnvironmentId.make("env-2");

  const connection1 = {
    httpBaseUrl: "https://machine-1.devtunnels.ms",
    tunnelToken: "tunnel-token-machine-1",
  };

  const connection2 = {
    httpBaseUrl: "https://machine-2.devtunnels.ms",
    tunnelToken: "tunnel-token-machine-2",
  };

  beforeEach(() => {
    clearActiveDevTunnels();
    registerActiveDevTunnel(env1, connection1);
    registerActiveDevTunnel(env2, connection2);
  });

  it("attaches tunnel header when requested URL matches exact secure origin of PreparedConnection", () => {
    const headers = devTunnelHeaders("https://machine-1.devtunnels.ms/api/assets/123", connection1);
    expect(headers).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-1",
    });
  });

  it("never sends T3 bearer into asset requests", () => {
    const connectionWithBearer = {
      ...connection1,
      httpAuthorization: { _tag: "Bearer", token: "t3-secret-bearer" },
    };
    const headers = devTunnelHeaders(
      "https://machine-1.devtunnels.ms/api/assets/123",
      connectionWithBearer,
    );
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers?.[DEV_TUNNEL_HEADER]).toBe("tunnel tunnel-token-machine-1");
  });

  it("does not attach headers to plain HTTP (non-secure) URLs", () => {
    const insecureConnection = {
      httpBaseUrl: "http://machine-1.devtunnels.ms",
      tunnelToken: "token-1",
    };
    expect(
      devTunnelHeaders("http://machine-1.devtunnels.ms/asset.png", insecureConnection),
    ).toBeUndefined();
    expect(
      devTunnelHeaders("http://machine-1.devtunnels.ms/asset.png", connection1),
    ).toBeUndefined();
  });

  it("does not attach headers to a different host or sub-domain", () => {
    expect(
      devTunnelHeaders("https://machine-2.devtunnels.ms/asset.png", connection1),
    ).toBeUndefined();
    expect(devTunnelHeaders("https://other.devtunnels.ms/asset.png", connection1)).toBeUndefined();
  });

  it("does not attach headers to a different port", () => {
    expect(
      devTunnelHeaders("https://machine-1.devtunnels.ms:8443/asset.png", connection1),
    ).toBeUndefined();
  });

  it("does not attach tunnel token to unrelated source-control or external image URLs", () => {
    expect(
      devTunnelHeaders("https://raw.githubusercontent.com/org/repo/main/image.png", connection1),
    ).toBeUndefined();
    expect(
      devTunnelHeaders("https://images.unsplash.com/photo-12345", connection1),
    ).toBeUndefined();
  });

  it("returns undefined if connection has no tunnel token", () => {
    const noTunnelConnection = {
      httpBaseUrl: "https://machine-1.devtunnels.ms",
      tunnelToken: undefined,
    };
    expect(
      devTunnelHeaders("https://machine-1.devtunnels.ms/asset.png", noTunnelConnection),
    ).toBeUndefined();
  });

  it("supports two machines with independent secure origins and tunnel tokens", () => {
    expect(devTunnelHeaders("https://machine-1.devtunnels.ms/asset.png", env1)).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-1",
    });

    expect(devTunnelHeaders("https://machine-2.devtunnels.ms/asset.png", env2)).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-2",
    });

    // Resolving without explicit target: finds active tunnel by origin
    expect(devTunnelHeaders("https://machine-1.devtunnels.ms/file.pdf")).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-1",
    });

    expect(devTunnelHeaders("https://machine-2.devtunnels.ms/video.mp4")).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-2",
    });
  });

  it("supports token replacement from connection state", () => {
    expect(devTunnelHeaders("https://machine-1.devtunnels.ms/asset.png", env1)).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel tunnel-token-machine-1",
    });

    registerActiveDevTunnel(env1, {
      httpBaseUrl: "https://machine-1.devtunnels.ms",
      tunnelToken: "renewed-token-999",
    });

    expect(devTunnelHeaders("https://machine-1.devtunnels.ms/asset.png", env1)).toEqual({
      [DEV_TUNNEL_HEADER]: "tunnel renewed-token-999",
    });
  });
});

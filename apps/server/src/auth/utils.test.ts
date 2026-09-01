import { describe, expect, it } from "vite-plus/test";

import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      environmentId: "environment-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      environmentId: "environment-two",
      development: true,
    });

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-one",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-two",
      environmentId: "environment-two",
      development: false,
    });

    expect(first).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });

    expect(first).toBe(second);
  });

  it("retains desktop port scoping", () => {
    expect(
      resolveSessionCookieName({
        mode: "desktop",
        port: 3773,
        host: "127.0.0.1",
        instanceKey: "/tmp/desktop",
        environmentId: "environment-one",
        development: true,
      }),
    ).toBe("t3_session_3773");
  });

  it("isolates development servers even when they bind a wildcard host", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 5775,
        host: "0.0.0.0",
        instanceKey: "/tmp/t3-wildcard-dev",
        environmentId: "environment-one",
        development: true,
      }),
    ).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    expect(isRemoteReachableHost(undefined)).toBe(false);
    expect(isRemoteReachableHost("localhost")).toBe(false);
    expect(isRemoteReachableHost("127.12.0.1")).toBe(false);
    expect(isRemoteReachableHost("[::1]")).toBe(false);
    expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
    expect(isRemoteReachableHost("192.168.1.50")).toBe(true);
  });
});

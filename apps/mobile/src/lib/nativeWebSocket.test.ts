import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createNativeWebSocket } from "./nativeWebSocket";

describe("createNativeWebSocket", () => {
  const originalWebSocket = globalThis.WebSocket;
  const mockWebSocket = vi.fn();

  beforeEach(() => {
    mockWebSocket.mockReset();
    globalThis.WebSocket = mockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("preserves ordinary sockets without protocols", () => {
    createNativeWebSocket("wss://example.com/ws");
    expect(mockWebSocket).toHaveBeenCalledWith("wss://example.com/ws", undefined);
  });

  it("preserves ordinary sockets with a single protocol string", () => {
    createNativeWebSocket("wss://example.com/ws", "v1.proto");
    expect(mockWebSocket).toHaveBeenCalledWith("wss://example.com/ws", "v1.proto");
  });

  it("preserves ordinary sockets with a protocol array", () => {
    createNativeWebSocket("wss://example.com/ws", ["v1.proto", "v2.proto"]);
    expect(mockWebSocket).toHaveBeenCalledWith("wss://example.com/ws", ["v1.proto", "v2.proto"]);
  });

  it("translates options with headers to native React Native 3-argument constructor", () => {
    createNativeWebSocket("wss://example.com/ws", {
      protocols: "v1.proto",
      headers: { "X-Tunnel-Authorization": "tunnel token-123" },
    });
    expect(mockWebSocket).toHaveBeenCalledWith("wss://example.com/ws", "v1.proto", {
      headers: { "X-Tunnel-Authorization": "tunnel token-123" },
    });
  });

  it("supports options with headers when protocols is omitted", () => {
    createNativeWebSocket("wss://example.com/ws", {
      headers: { "X-Tunnel-Authorization": "tunnel token-123" },
    });
    expect(mockWebSocket).toHaveBeenCalledWith("wss://example.com/ws", undefined, {
      headers: { "X-Tunnel-Authorization": "tunnel token-123" },
    });
  });
});

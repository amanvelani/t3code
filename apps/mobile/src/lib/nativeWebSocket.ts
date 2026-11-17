import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

export type WebSocketConstructorOptions =
  | string
  | string[]
  | {
      readonly protocols?: string | string[];
      readonly headers?: Record<string, string>;
    }
  | undefined;

export function createNativeWebSocket(
  url: string,
  options?: WebSocketConstructorOptions,
): WebSocket {
  if (options !== undefined && typeof options === "object" && !Array.isArray(options)) {
    const { protocols, headers } = options;
    const WebSocketImpl = globalThis.WebSocket as unknown as new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    return new WebSocketImpl(url, protocols, headers ? { headers } : undefined);
  }
  return new globalThis.WebSocket(url, options);
}

export const layerNativeWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Layer.succeed(Socket.WebSocketConstructor)(createNativeWebSocket);

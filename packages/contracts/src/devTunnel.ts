import * as Schema from "effect/Schema";

export const DevTunnelState = Schema.Struct({
  enabled: Schema.Boolean,
  status: Schema.Literals(["stopped", "starting", "running", "failed"]),
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type DevTunnelState = typeof DevTunnelState.Type;

export class DevTunnelError extends Schema.TaggedError<DevTunnelError>()("DevTunnelError", {
  reason: Schema.Literals([
    "not-installed",
    "login-required",
    "configuration",
    "start-failed",
    "not-running",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-installed":
        return "Install the Microsoft devtunnel CLI on the server and make it available on PATH.";
      case "login-required":
        return "Sign in on the server with `devtunnel user login -d`, then try again.";
      case "configuration":
        return "Could not save or configure the Dev Tunnel.";
      case "start-failed":
        return "The Dev Tunnel could not connect. Check `devtunnel user show` on the server, then retry.";
      case "not-running":
        return "Start Dev Tunnels in Settings → Connections or run `t3 serve --dev-tunnel` first.";
    }
  }
}

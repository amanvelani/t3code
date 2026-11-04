import * as NodeBuffer from "node:buffer";
import * as NodeProcess from "node:process";

const { Buffer } = NodeBuffer;
const process = NodeProcess;

const mode = process.argv[2];
let buffer = Buffer.alloc(0);
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  process.stdout.write(frame.subarray(0, 8));
  process.stdout.write(frame.subarray(8));
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (mode === "closed") process.exit(0);
    if (mode === "malformed") {
      process.stdout.end("Content-Length: invalid\r\n\r\n");
      return;
    }
    if (request.method === "connect") {
      reply({ jsonrpc: "2.0", method: "notification", params: {} });
      reply({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 3 } });
    } else if (request.method === "auth.getStatus") {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isAuthenticated: mode !== "unauthenticated",
          login: mode === "other-account" ? "other" : "tést",
          host: "https://github.com",
        },
      });
    } else if (request.method === "account.getQuota") {
      reply(
        mode === "quota-failed"
          ? { jsonrpc: "2.0", id: request.id, error: { code: -1, message: "unavailable" } }
          : {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                quotaSnapshots: {
                  premium_interactions: {
                    isUnlimitedEntitlement: false,
                    entitlementRequests: 1000,
                    remainingPercentage: 75,
                    tokenBasedBilling: true,
                  },
                },
              },
            },
      );
    } else {
      process.exitCode = 2;
      process.stdin.destroy();
    }
  }
});

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { BearerConnectionCredential } from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import { BearerConnectionTarget } from "./model.ts";
import { renewDevTunnelAccess } from "./devTunnelRenewal.ts";

describe("Dev Tunnel credential renewal", () => {
  it.effect("renews only the selected route and preserves its T3 session", () =>
    Effect.gen(function* () {
      const token = `eyJhbGciOiJSUzI1NiJ9.${btoa('{"exp":1800}')}.signature`;
      const target = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("machine-a"),
        connectionId: "machine-a-tunnel",
        label: "A",
      });
      const saved = new Map([
        [
          target.connectionId,
          new BearerConnectionCredential({ token: "t3-a", tunnelToken: token }),
        ],
        [
          "machine-b-tunnel",
          new BearerConnectionCredential({ token: "t3-b", tunnelToken: "tunnel-b" }),
        ],
      ]);
      const outcome = yield* Effect.result(
        renewDevTunnelAccess({
          prepared: {
            environmentId: target.environmentId,
            label: "A",
            target,
            httpBaseUrl: "https://a.usw2.devtunnels.ms",
            socketUrl: "wss://a.usw2.devtunnels.ms/ws",
            httpAuthorization: { _tag: "Bearer", token: "t3-a" },
            tunnelToken: token,
          },
          issueToken: () => Effect.succeed({ token: "renewed-a", expiresAtEpochMs: 86_400_000 }),
        }).pipe(
          Effect.provideService(CredentialStore.ConnectionCredentialStore, {
            get: (id) => Effect.succeed(Option.fromUndefinedOr(saved.get(id))),
            put: (id, value) =>
              Effect.sync(() => {
                saved.set(id, value);
              }),
            remove: () => Effect.void,
          }),
        ),
      );
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { reason: "transport", hop: "tunnel" },
      });
      expect(saved.get(target.connectionId)).toMatchObject({
        token: "t3-a",
        tunnelToken: "renewed-a",
      });
      expect(saved.get("machine-b-tunnel")).toMatchObject({
        token: "t3-b",
        tunnelToken: "tunnel-b",
      });
    }),
  );
});

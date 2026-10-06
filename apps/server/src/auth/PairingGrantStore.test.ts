import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";

import * as ServerConfig from "../config.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const layerServerConfig = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

const layerPairingGrantStore = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerServerConfig(overrides)),
  );

const layerPairingGrantStoreTest = (
  overrides: Partial<AuthPairingLinks.AuthPairingLinkRepository["Service"]>,
) =>
  Layer.effect(PairingGrantStore.PairingGrantStore, PairingGrantStore.make).pipe(
    Layer.provide(
      Layer.succeed(
        AuthPairingLinks.AuthPairingLinkRepository,
        AuthPairingLinks.AuthPairingLinkRepository.of({
          create: () => Effect.void,
          consumeAvailable: () => Effect.succeedNone,
          listActive: () => Effect.succeed([]),
          revoke: () => Effect.succeed(false),
          getByCredential: () => Effect.succeedNone,
          ...overrides,
        }),
      ),
    ),
    Layer.provide(layerServerConfig()),
  );

it.layer(NodeServices.layer)("PairingGrantStore.layer", (it) => {
  it.effect("issues pairing tokens in a short manual-entry format", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issuePairingToken();

      expect(issued.credential).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("issues one-time bootstrap tokens that can only be consumed once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issuePairingToken({ label: "Julius iPhone" });
      const first = yield* bootstrapCredentials.consume(issued.credential);
      const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));

      expect(first.method).toBe("one-time-token");
      expect(first.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ]);
      expect(first.subject).toBe("one-time-token");
      expect(first.label).toBe("Julius iPhone");
      expect(issued.label).toBe("Julius iPhone");
      expect(second._tag).toBe("UnknownBootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issuePairingToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(bootstrapCredentials.consume(token.credential)),
        ),
        {
          concurrency: "unbounded",
        },
      );

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("UnknownBootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("reuses a persisted link across devices and store instances until revoked", () =>
    Effect.gen(function* () {
      const firstStore = yield* PairingGrantStore.make;
      const issued = yield* firstStore.issuePairingToken({ reusable: true, label: "Dev Tunnels" });
      const secondStore = yield* PairingGrantStore.make;
      const grants = yield* Effect.all(
        Array.from({ length: 8 }, () => secondStore.consume(issued.credential)),
        { concurrency: "unbounded" },
      );
      expect(grants).toHaveLength(8);
      expect(grants.every((grant) => grant.method === "one-time-token")).toBe(true);
      expect(grants.every((grant) => grant.label === "Dev Tunnels")).toBe(true);
      const active = yield* secondStore.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(issued.id);
      expect(active[0]?.reusable).toBe(true);
      expect(active[0]).not.toHaveProperty("credential");
      expect(yield* secondStore.revoke(issued.id)).toBe(true);
      expect(yield* firstStore.listActive()).toHaveLength(0);
      const rejected = yield* Effect.flip(firstStore.consume(issued.credential));
      expect(rejected._tag).toBe("UnavailableBootstrapCredentialError");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          AuthPairingLinks.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          layerServerConfig(),
        ),
      ),
    ),
  );

  it.effect("expires reusable links after 30 days without consuming them on use", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* grants.issuePairingToken({ reusable: true });
      yield* grants.consume(issued.credential);
      yield* TestClock.adjust(Duration.days(29));
      yield* grants.consume(issued.credential);
      yield* TestClock.adjust(Duration.days(1));
      const rejected = yield* Effect.flip(grants.consume(issued.credential));
      expect(rejected._tag).toBe("ExpiredBootstrapCredentialError");
      expect(yield* grants.listActive()).toHaveLength(0);
    }).pipe(Effect.provide(layerPairingGrantStore().pipe(Layer.provideMerge(TestClock.layer())))),
  );

  it.effect("keeps reusable links proof-bound when a key is specified", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* grants.issuePairingToken({
        reusable: true,
        proofKeyThumbprint: "allowed-key",
      });
      const rejected = yield* Effect.flip(grants.consume(issued.credential));
      expect(rejected._tag).toBe("BootstrapCredentialProofKeyMismatchError");
      yield* grants.consume(issued.credential, { proofKeyThumbprint: "allowed-key" });
      yield* grants.consume(issued.credential, { proofKeyThumbprint: "allowed-key" });
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("requires the bound proof key thumbprint when present", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issuePairingToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
      });

      const missing = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(token.credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
      });

      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("seeds the desktop bootstrap credential as a reusable grant", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const first = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      const second = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      const third = yield* bootstrapCredentials.consume("desktop-bootstrap-token");

      expect(first.method).toBe("desktop-bootstrap");
      expect(first.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      expect(first.subject).toBe("desktop-bootstrap");
      expect(second.method).toBe("desktop-bootstrap");
      expect(third.method).toBe("desktop-bootstrap");
    }).pipe(
      Effect.provide(
        layerPairingGrantStore({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;

      // The desktop-bootstrap grant lives for 24h. Within that window
      // it stays reusable.
      yield* TestClock.adjust(Duration.hours(12));
      const stillValid = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      expect(stillValid.method).toBe("desktop-bootstrap");

      yield* TestClock.adjust(Duration.hours(13));
      const expired = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));

      expect(expired._tag).toBe("ExpiredBootstrapCredentialError");
      expect(expired.message).toContain("Bootstrap credential expired");
    }).pipe(
      Effect.provide(
        layerPairingGrantStore({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }).pipe(Layer.provideMerge(TestClock.layer())),
      ),
    ),
  );

  it.effect("accepts rotating desktop bootstrap tokens derived from the desktop secret", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const window = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

      // A desktop open for days hands the renderer a fresh token each window.
      yield* TestClock.adjust(Duration.days(5));
      const now = 5 * 24 * 60 * 60 * 1000;
      const current = yield* bootstrapCredentials.consume(
        currentDesktopBootstrapToken("desktop-secret", now),
      );
      expect(current.method).toBe("desktop-bootstrap");

      const stale = yield* Effect.flip(
        bootstrapCredentials.consume(
          currentDesktopBootstrapToken("desktop-secret", now - 2 * window),
        ),
      );
      expect(stale._tag).toBe("UnknownBootstrapCredentialError");

      // The launch token is not accepted on its own once a secret is present.
      const launch = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));
      expect(launch._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
            desktopBootstrapSecret: "desktop-secret",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("keeps credentials out of pairing lists and change events", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      for (const input of [{}, { label: "Synthetic phone" }]) {
        const issued = yield* grants.issuePairingToken(input);
        const change = yield* Queue.take(changes);
        expect(change?.type).toBe("pairingLinkUpserted");
        if (change?.type !== "pairingLinkUpserted")
          throw new Error("Expected a pairing link update");
        expect(change.pairingLink.id).toBe(issued.id);
        expect(change.pairingLink).not.toHaveProperty("credential");
        const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
        expect(listed).toEqual(change.pairingLink);
        const consumed = yield* grants.consume(issued.credential);
        expect(consumed.scopes).toEqual(change.pairingLink.scopes);
        expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: issued.id });
      }
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );

  it.effect("does not remove a reusable link from client change streams after pairing", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const reusable = yield* grants.issuePairingToken({ reusable: true });
      const created = yield* Queue.take(changes);
      expect(created.type).toBe("pairingLinkUpserted");
      yield* grants.consume(reusable.credential);
      const nextLink = yield* grants.issuePairingToken();
      const nextChange = yield* Queue.take(changes);
      expect(nextChange.type).toBe("pairingLinkUpserted");
      if (nextChange.type === "pairingLinkUpserted") {
        expect(nextChange.pairingLink.id).toBe(nextLink.id);
      }
      yield* grants.revoke(reusable.id);
      expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: reusable.id });
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );

  it.effect("lists and revokes active pairing links", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const first = yield* bootstrapCredentials.issuePairingToken();
      const second = yield* bootstrapCredentials.issuePairingToken({
        scopes: ["orchestration:read", "access:write"],
      });

      const activeBeforeRevoke = yield* bootstrapCredentials.listActive();
      expect(activeBeforeRevoke.map((entry) => entry.id)).toContain(first.id);
      expect(activeBeforeRevoke.map((entry) => entry.id)).toContain(second.id);
      for (const entry of activeBeforeRevoke) {
        expect(entry).not.toHaveProperty("credential");
      }

      const revoked = yield* bootstrapCredentials.revoke(first.id);
      const activeAfterRevoke = yield* bootstrapCredentials.listActive();
      const revokedConsume = yield* Effect.flip(bootstrapCredentials.consume(first.credential));

      expect(revoked).toBe(true);
      expect(activeAfterRevoke.map((entry) => entry.id)).not.toContain(first.id);
      expect(activeAfterRevoke.map((entry) => entry.id)).toContain(second.id);
      expect(revokedConsume.message).toContain("no longer available");
      expect(revokedConsume._tag).toBe("UnavailableBootstrapCredentialError");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("identifies consume-available failures and preserves their cause", () => {
    const repositoryFailure = new PersistenceSqlError({
      operation: "consume-pairing-link",
      detail: "Database unavailable",
      cause: new Error("database unavailable"),
    });

    return Effect.gen(function* () {
      const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
      const error = yield* Effect.flip(pairingGrants.consume("credential"));

      if (error._tag !== "BootstrapCredentialConsumeAvailableError") {
        return yield* Effect.die(error);
      }
      expect(error.cause).toBe(repositoryFailure);
    }).pipe(
      Effect.provide(
        layerPairingGrantStoreTest({
          consumeAvailable: () => Effect.fail(repositoryFailure),
        }),
      ),
    );
  });
});

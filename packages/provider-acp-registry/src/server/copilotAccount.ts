import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { AcpSpawnInput } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class CopilotAccountError extends Schema.TaggedError<CopilotAccountError>()("CopilotAccountError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return "Copilot account usage could not be read.";
  }
}

const Reply = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const Auth = Schema.Struct({
  isAuthenticated: Schema.Boolean,
  login: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
});
const Quota = Schema.Struct({
  isUnlimitedEntitlement: Schema.Boolean,
  entitlementRequests: Schema.Finite,
  remainingPercentage: Schema.Finite,
  tokenBasedBilling: Schema.optional(Schema.Boolean),
  hasQuota: Schema.optional(Schema.Boolean),
  resetDate: Schema.optional(Schema.String),
});
const Quotas = Schema.Struct({ quotaSnapshots: Schema.Record(Schema.String, Schema.Unknown) });
const decodeReply = Schema.decodeOption(Schema.fromJsonString(Reply));
const decodeAuth = Schema.decodeUnknownEffect(Auth);
const decodeQuotas = Schema.decodeUnknownEffect(Quotas);
const decodeQuota = Schema.decodeUnknownOption(Quota);
const isCopilotAccountError = Schema.is(CopilotAccountError);
const USAGE_URL = "https://github.com/settings/billing/usage";

export function copilotQuotaLimits(value: typeof Quotas.Type, checkedAt: string) {
  const windows: ServerProviderUsageWindow[] = [];
  let unlimited = false;
  for (const [id, raw] of Object.entries(value.quotaSnapshots)) {
    if (!["premium_interactions", "ai_credits", "chat", "completions"].includes(id)) continue;
    const decoded = decodeQuota(raw);
    if (Option.isNone(decoded) || decoded.value.hasQuota === false) continue;
    const quota = decoded.value;
    if (quota.isUnlimitedEntitlement || quota.entitlementRequests === -1) {
      unlimited ||= id === "premium_interactions" || id === "ai_credits";
      continue;
    }
    if (quota.entitlementRequests <= 0) continue;
    const reset = quota.resetDate === undefined ? Option.none() : DateTime.make(quota.resetDate);
    windows.push({
      id: `copilot_${id}`,
      kind: "monthly",
      label:
        quota.tokenBasedBilling || id === "ai_credits"
          ? "AI credits"
          : id === "premium_interactions"
            ? "Premium requests"
            : id === "chat"
              ? "Chat"
              : "Completions",
      usedPercent: clampPercent(100 - quota.remainingPercentage),
      ...(Option.isSome(reset) && DateTime.toEpochMillis(reset.value) > Date.parse(checkedAt)
        ? { resetsAt: DateTime.formatIso(reset.value) }
        : {}),
    });
  }
  if (windows.length > 0) return makeUsageLimits({ checkedAt, windows });
  if (unlimited)
    return {
      ...makeUsageLimits({ checkedAt, windows: [] }),
      externalUsage: { label: "GitHub Copilot · Unlimited", url: USAGE_URL },
    };
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Copilot did not report a subscription allowance.",
  });
}

const frame = (id: number, method: string) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

const connect = Effect.fn("CopilotAccount.connect")(function* (spawn: AcpSpawnInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner.spawn(
    ChildProcess.make(
      spawn.command,
      [...spawn.args.filter((arg) => arg !== "--acp"), "--headless", "--stdio"],
      {
        cwd: spawn.cwd,
        env: spawn.env,
        extendEnv: spawn.extendEnv ?? false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "1 second",
      },
    ),
  );
  let pending: { id: number; reply: Deferred.Deferred<unknown, CopilotAccountError> } | undefined;
  let failure: CopilotAccountError | undefined;
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const fail = (error: CopilotAccountError) =>
    Effect.sync(() => {
      failure = error;
      if (pending) Deferred.doneUnsafe(pending.reply, Effect.fail(error));
    });
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catch((cause) => fail(new CopilotAccountError({ operation: "write", cause }))),
    Effect.forkIn(scope),
  );
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.try({
        try: () => {
          if (buffer.length + chunk.length > 1024 * 1024)
            throw new Error("Copilot reply too large");
          buffer = Buffer.concat([buffer, chunk]);
          while (true) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const length = Number(
              /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
            );
            if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) {
              throw new Error("Invalid Copilot reply framing");
            }
            if (buffer.length < end + 4 + length) return;
            const message = decodeReply(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length);
            if (Option.isNone(message) || message.value.id !== pending?.id) continue;
            const reply = pending.reply;
            pending = undefined;
            Deferred.doneUnsafe(
              reply,
              message.value.error === undefined
                ? Effect.succeed(message.value.result)
                : Effect.fail(new CopilotAccountError({ operation: "request" })),
            );
          }
        },
        catch: (cause) => new CopilotAccountError({ operation: "read", cause }),
      }),
    ),
    Effect.catch((cause) =>
      fail(
        isCopilotAccountError(cause)
          ? cause
          : new CopilotAccountError({ operation: "read", cause }),
      ),
    ),
    Effect.ensuring(fail(new CopilotAccountError({ operation: "closed" }))),
    Effect.forkIn(scope),
  );
  // Each probe has one request in flight and owns the subprocess for its whole scope.
  return Effect.fn("CopilotAccount.request")(function* (method: string) {
    if (failure) return yield* failure;
    const reply = yield* Deferred.make<unknown, CopilotAccountError>();
    const id = ++nextId;
    pending = { id, reply };
    yield* Queue.offer(outgoing, frame(id, method));
    return yield* Deferred.await(reply);
  });
});

export const readCopilotAccount = Effect.fn("readCopilotAccount")(function* (spawn: AcpSpawnInput) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const failed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Copilot could not read subscription limits.",
  });
  const empty = {
    authenticated: undefined as boolean | undefined,
    accountId: undefined as string | undefined,
    usageLimits: failed,
  };
  return yield* Effect.gen(function* () {
    const request = yield* connect(spawn);
    yield* request("connect");
    const auth = yield* request("auth.getStatus").pipe(Effect.flatMap(decodeAuth));
    if (!auth.isAuthenticated)
      return {
        ...empty,
        authenticated: false,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Sign in to GitHub Copilot to read limits.",
        }),
      };
    const digest = yield* Digest.Digest;
    const accountId = auth.login?.trim()
      ? yield* digest
          .digest(
            Digest.sha256,
            new TextEncoder().encode(
              `copilot\0${auth.host ?? "https://github.com"}\0${auth.login.toLowerCase()}`,
            ),
          )
          .pipe(Effect.map(Hex.encode), Effect.orDie)
      : undefined;
    const usageLimits = yield* request("account.getQuota").pipe(
      Effect.flatMap(decodeQuotas),
      Effect.map((quotas) => copilotQuotaLimits(quotas, checkedAt)),
      Effect.orElseSucceed(() => failed),
    );
    return {
      authenticated: true,
      accountId,
      usageLimits: { ...usageLimits, ...(accountId ? { credentialFingerprint: accountId } : {}) },
    };
  }).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => empty),
  );
});

import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { copilotQuotaLimits, readCopilotAccount } from "./copilotAccount.ts";

const checkedAt = "2026-11-01T00:00:00.000Z";
const quota = {
  isUnlimitedEntitlement: false,
  entitlementRequests: 1000,
  remainingPercentage: 75.5,
  tokenBasedBilling: true,
  resetDate: "2026-12-01T00:00:00Z",
};

describe("Copilot account limits", () => {
  it("uses the reported credit balance and monthly reset without counting unlimited chat twice", () => {
    const limits = copilotQuotaLimits(
      {
        quotaSnapshots: {
          premium_interactions: quota,
          chat: { ...quota, isUnlimitedEntitlement: true },
          completions: { ...quota, isUnlimitedEntitlement: true },
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "copilot_premium_interactions",
        label: "AI credits",
        kind: "monthly",
        usedPercent: 24.5,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
    expect(
      copilotQuotaLimits(
        {
          quotaSnapshots: {
            premium_interactions: {
              ...quota,
              tokenBasedBilling: false,
              remainingPercentage: -5,
              resetDate: checkedAt,
            },
          },
        },
        checkedAt,
      ).windows,
    ).toEqual([
      {
        id: "copilot_premium_interactions",
        label: "Premium requests",
        kind: "monthly",
        usedPercent: 100,
      },
    ]);
  });

  it("keeps missing and malformed quotas unavailable instead of reporting an exhausted allowance", () => {
    for (const raw of [
      undefined,
      null,
      {},
      { ...quota, hasQuota: false },
      { ...quota, remainingPercentage: Infinity },
      { ...quota, entitlementRequests: 0 },
    ]) {
      const limits = copilotQuotaLimits(
        {
          quotaSnapshots: {
            premium_interactions: raw,
            chat: { ...quota, isUnlimitedEntitlement: true },
            completions: { ...quota, isUnlimitedEntitlement: true },
          },
        },
        checkedAt,
      );
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }
    const unlimited = copilotQuotaLimits(
      {
        quotaSnapshots: {
          premium_interactions: { ...quota, isUnlimitedEntitlement: true },
        },
      },
      checkedAt,
    );
    expect(unlimited.externalUsage?.label).toBe("GitHub Copilot · Unlimited");
  });

  const fixture = (file: string, mode = "ready") => ({
    command: process.execPath,
    args: [file, mode, "--acp"],
    env: {},
  });

  it.live(
    "reads the selected CLI account with framed RPC and deduplicates that identity across probes",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = yield* path.fromFileUrl(
          new URL("./testing/copilotAccount.fixture.mjs", import.meta.url),
        );
        const first = yield* readCopilotAccount(fixture(file));
        const again = yield* readCopilotAccount(fixture(file));
        const other = yield* readCopilotAccount(fixture(file, "other-account"));
        expect(first.authenticated).toBe(true);
        expect(first.usageLimits.windows).toMatchObject([{ label: "AI credits", usedPercent: 25 }]);
        expect(first.accountId).toMatch(/^[a-f0-9]{64}$/);
        expect(first.accountId).toBe(again.accountId);
        expect(first.accountId).not.toBe(other.accountId);
        expect(first.usageLimits.credentialFingerprint).toBe(first.accountId);
      }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
  );

  it.live(
    "handles signed-out accounts and failed, malformed, or closed probes without fake limits",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = yield* path.fromFileUrl(
          new URL("./testing/copilotAccount.fixture.mjs", import.meta.url),
        );
        const signedOut = yield* readCopilotAccount(fixture(file, "unauthenticated"));
        expect(signedOut.authenticated).toBe(false);
        expect(signedOut.usageLimits.unavailable?.reason).toBe("unsupported");
        for (const mode of ["quota-failed", "malformed", "closed"]) {
          const result = yield* readCopilotAccount(fixture(file, mode));
          expect(result.usageLimits.windows).toEqual([]);
          expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
          if (mode === "quota-failed") expect(result.accountId).toMatch(/^[a-f0-9]{64}$/);
        }
      }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
  );
});

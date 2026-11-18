import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { AcpRegistrySettings } from "../settings.ts";
import { isCopilotAgent } from "./copilotAcp.ts";

/** Copilot bills in AI credits: 1 credit is 10^9 nano-AIU and costs $0.01. */
const USD_PER_NANO_AIU = 0.01 / 1_000_000_000;

const UsageRecordEntry = Schema.Struct({
  type: Schema.Literal("session.usage_record"),
  id: Schema.String,
  timestamp: Schema.String,
  data: Schema.Struct({
    usage: Schema.Struct({
      model: Schema.NonEmptyString,
      inputTokens: Schema.optional(Schema.Unknown),
      outputTokens: Schema.optional(Schema.Unknown),
      cacheReadTokens: Schema.optional(Schema.Unknown),
      cacheWriteTokens: Schema.optional(Schema.Unknown),
      reasoningTokens: Schema.optional(Schema.Unknown),
      accounting: Schema.optional(
        Schema.Struct({
          sourceSessionId: Schema.optional(Schema.String),
          usageId: Schema.optional(Schema.String),
        }),
      ),
      copilotUsage: Schema.optional(
        Schema.Struct({ totalNanoAiu: Schema.optional(Schema.Unknown) }),
      ),
    }),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(UsageRecordEntry);

/** A line copilot-relay writes per billed upstream call for the Codex and Claude it serves. */
const RelayUsageEntry = Schema.Struct({
  type: Schema.Literal("copilot.relay_usage"),
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  copilot_usage: Schema.Struct({
    total_nano_aiu: Schema.Unknown,
    token_details: Schema.Array(
      Schema.Struct({
        model: Schema.optional(Schema.String),
        token_type: Schema.optional(Schema.String),
        token_count: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
});
const decodeRelayEntry = Schema.decodeUnknownOption(RelayUsageEntry);

function nanoAiuCost(nanoAiu: unknown): number | null {
  return typeof nanoAiu === "number" && Number.isFinite(nanoAiu) && nanoAiu >= 0
    ? nanoAiu * USD_PER_NANO_AIU
    : null;
}

function parseRelayRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeRelayEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const details = entry.copilot_usage.token_details;
  // Copilot bills input, cache_read and cache_write separately, so they are already disjoint.
  const count = (type: string) =>
    details.reduce(
      (sum, detail) => (detail.token_type === type ? sum + tokenCount(detail.token_count) : sum),
      0,
    );
  const totals = {
    uncachedInputTokens: count("input"),
    cachedInputTokens: count("cache_read"),
    cacheCreationTokens: count("cache_write"),
    outputTokens: count("output"),
    reasoningTokens: 0,
  };
  const reportedCostUsd = nanoAiuCost(entry.copilot_usage.total_nano_aiu);
  if (totalTokens(totals) === 0 && !reportedCostUsd) return [];
  return [
    {
      provider: "copilot",
      timestampMs,
      model: details.find((detail) => detail.model)?.model ?? "unknown",
      sessionId: "",
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["copilot-relay", entry.id]),
    },
  ];
}

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return parseRelayRecord(parsed);
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const usage = entry.data.usage;
  // inputTokens includes cache reads and writes; the shared totals keep them disjoint.
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  const reportedCostUsd = nanoAiuCost(usage.copilotUsage?.totalNanoAiu);
  if (totalTokens(totals) === 0 && !reportedCostUsd) return [];
  const usageId = usage.accounting?.usageId;
  return [
    {
      provider: "copilot",
      timestampMs,
      model: usage.model,
      sessionId: usage.accounting?.sourceSessionId ?? "",
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["copilot", usageId || entry.id]),
    },
  ];
}

export const copilotUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      usage: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        accounting: { sourceSessionId: true, usageId: true },
        copilotUsage: { totalNanoAiu: true },
      },
    },
    copilot_usage: true,
  },
  usageMarkers: ['"session.usage_record"', '"copilot.relay_usage"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: (projected) => parseRecord(projected),
};

/**
 * Reads copilot-relay's usage files, and Copilot CLI session logs for ACP Registry accounts that
 * run GitHub Copilot. The relay is a host service, so its directory ignores instance settings.
 */
export const copilotUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const hostHome = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const relay = { dir: path.join(hostHome, ".copilot-relay", "usage") };
    if (config === undefined || !isCopilotAgent(config)) return [relay];
    const dir = resolveCopilotSessionStateDir(environment, hostHome, platform, path);
    return dir === null ? [relay] : [relay, { dir, fileName: "events.jsonl" }];
  }),
};

/**
 * Copilot keeps sessions in `$COPILOT_HOME/session-state`, else `~/.copilot/session-state`.
 * Copilot uses COPILOT_HOME verbatim, so a relative one depends on its unknown working directory.
 */
function resolveCopilotSessionStateDir(
  environment: NodeJS.ProcessEnv,
  hostHome: string,
  platform: NodeJS.Platform,
  path: Path.Path,
): string | null {
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || hostHome;
  const copilotHome = environment.COPILOT_HOME;
  if (copilotHome) {
    // Windows treats `\dir` as absolute, but it resolves against the current drive.
    const fullyQualified =
      platform === "win32"
        ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(copilotHome)
        : path.isAbsolute(copilotHome);
    return fullyQualified ? path.join(copilotHome, "session-state") : null;
  }
  return path.join(home, ".copilot", "session-state");
}

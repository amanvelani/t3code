import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
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
import { isCopilotAcpSettings } from "./copilotAcp.ts";

const ScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  hasUsageRecords: Schema.mutableKey(Schema.Boolean),
});
const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  cacheReadTokens: Schema.optional(Schema.Unknown),
  cacheWriteTokens: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
});
const Metric = Schema.Struct({
  usage: Usage,
});
const Accounting = Schema.Struct({ sourceSessionId: Schema.NonEmptyString, sequence: Schema.Int });
const Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.resume"),
  }),
  Schema.Struct({
    type: Schema.Literal("session.usage_record"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    data: Schema.Struct({
      usage: Schema.Struct({
        ...Usage.fields,
        model: Schema.NonEmptyString,
        responseModel: Schema.optional(Schema.String),
        accounting: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.start"),
    data: Schema.Struct({ sessionId: Schema.NonEmptyString }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.shutdown"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    data: Schema.Struct({ modelMetrics: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
]);
const decodeEvent = Schema.decodeUnknownOption(Event);
const decodeMetric = Schema.decodeUnknownOption(Metric);
const decodeAccounting = Schema.decodeUnknownOption(Accounting);

function parseRecord(value: unknown, state: typeof ScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEvent(value);
  if (Option.isNone(decoded)) return [];
  const event = decoded.value;
  if (event.type === "session.start") {
    state.sessionId = event.data.sessionId;
    state.hasUsageRecords = false;
    return [];
  }
  if (event.type === "session.resume") {
    state.hasUsageRecords = false;
    return [];
  }
  const timestampMs = parseTimestampMs(event.timestamp);
  if (timestampMs === null || state.sessionId.length === 0) return [];
  if (event.type === "session.shutdown" && state.hasUsageRecords) return [];
  const entries =
    event.type === "session.usage_record"
      ? [
          [
            event.data.usage.responseModel?.trim() || event.data.usage.model,
            { usage: event.data.usage },
          ] as const,
        ]
      : Object.entries(event.data.modelMetrics);
  const records: UsageRecord[] = [];
  for (const [model, raw] of entries) {
    if (model.trim().length === 0) continue;
    const decodedMetric = decodeMetric(raw);
    if (Option.isNone(decodedMetric)) continue;
    const { usage } = decodedMetric.value;
    const cachedInputTokens = tokenCount(usage.cacheReadTokens);
    const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
    const outputTokens = tokenCount(usage.outputTokens);
    const totals = {
      uncachedInputTokens: Math.max(
        0,
        tokenCount(usage.inputTokens) - cachedInputTokens - cacheCreationTokens,
      ),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
    };
    if (totalTokens(totals) === 0) continue;
    if (event.type === "session.usage_record") state.hasUsageRecords = true;
    const accounting =
      event.type === "session.usage_record"
        ? decodeAccounting(event.data.usage.accounting)
        : Option.none();
    const rateModel = model
      .replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)(?=-|$)/, "$1-$2")
      .replace(/^(claude-.+)-1m$/, "$1");
    records.push({
      provider: "copilot",
      timestampMs,
      model,
      ...(rateModel === model ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // Copied parent/child usage keeps its source accounting sequence.
      dedupeKey: JSON.stringify(
        Option.isSome(accounting)
          ? ["copilot", accounting.value.sourceSessionId, accounting.value.sequence, model]
          : ["copilot", state.sessionId, event.id, model],
      ),
    });
  }
  return records;
}

export const copilotUsageFormat: TranscriptUsageFormat<typeof ScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      sessionId: true,
      modelMetrics: true,
      usage: {
        model: true,
        responseModel: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        accounting: { sourceSessionId: true, sequence: true },
      },
    },
  },
  usageMarkers: [
    '"session.start"',
    '"session.resume"',
    '"session.usage_record"',
    '"session.shutdown"',
  ],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "", hasUsageRecords: false }), schema: ScanState },
  sharedSessionsAcrossFiles: true,
};

export const copilotUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({
    config,
    configured,
    environment,
  }) {
    if (configured && (config === undefined || !isCopilotAcpSettings(config))) {
      return [];
    }
    const path = yield* Path.Path;
    const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
    let configDir = environment.COPILOT_HOME?.trim() || path.join(home, ".copilot");
    const args = config?.source === "local" ? config.commandArgs : [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg.startsWith("--config-dir=")) configDir = arg.slice("--config-dir=".length);
      else if (arg === "--config-dir" && args[index + 1]) configDir = args[++index]!;
    }
    return [
      {
        dir: path.resolve(expandHomePath(configDir, home), "session-state"),
        fileName: "events.jsonl",
      },
    ];
  }),
};

import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import { AcpRegistrySettings } from "../settings.ts";
import { copilotUsageFormat, copilotUsageReader } from "./copilotUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeState = Schema.decodeUnknownSync(copilotUsageFormat.state!.schema);
const encodeState = Schema.encodeSync(copilotUsageFormat.state!.schema);
const start = { type: "session.start", data: { sessionId: "session-1" } };
const shutdown = () => ({
  type: "session.shutdown",
  id: "shutdown-1",
  timestamp: "2026-11-01T10:00:00Z",
  data: {
    totalPremiumRequests: 30,
    totalNanoAiu: 27_166_150_000,
    modelMetrics: {
      "claude-opus-4.8": {
        requests: { count: 2, cost: 30 },
        totalNanoAiu: 27_166_150_000,
        usage: {
          inputTokens: 79_338,
          outputTokens: 96,
          cacheReadTokens: 39_408,
          cacheWriteTokens: 39_926,
          reasoningTokens: 20,
        },
      },
    },
  },
});
const parse = (events: readonly unknown[]) => {
  const state = copilotUsageFormat.state!.initial();
  return events.flatMap((event) => copilotUsageFormat.parseLine(JSON.stringify(event), state));
};

it("reads inclusive token counts for API-equivalent pricing", () => {
  const [record] = parse([start, shutdown()]);
  expect(record).toMatchObject({
    provider: "copilot",
    sessionId: "session-1",
    model: "claude-opus-4.8",
    rateModel: "claude-opus-4-8",
    timestampMs: Date.parse("2026-11-01T10:00:00Z"),
    totals: {
      uncachedInputTokens: 4,
      cachedInputTokens: 39_408,
      cacheCreationTokens: 39_926,
      outputTokens: 96,
      reasoningTokens: 20,
    },
  });
  expect(record?.reportedCostUsd).toBeNull();
  expect(totalTokens(record!.totals)).toBe(79_434);
  const event = shutdown();
  for (const [model, rateModel] of [
    ["claude-opus-4.6-1m", "claude-opus-4-6"],
    ["claude-haiku-4.5", "claude-haiku-4-5"],
    ["claude-sonnet-5", undefined],
    ["gpt-5.5", undefined],
  ]) {
    expect(
      parse([
        start,
        {
          ...event,
          data: { modelMetrics: { [model!]: event.data.modelMetrics["claude-opus-4.8"] } },
        },
      ])[0]?.rateModel,
    ).toBe(rateModel);
  }
});

it("keeps each model and resumed run separate and deduplicates copied shutdown events", () => {
  const first = shutdown();
  const second = { ...shutdown(), id: "shutdown-2" };
  const records = parse([start, first, { type: "session.resume", data: {} }, second, first]);
  expect(records).toHaveLength(3);
  expect(records[0]?.dedupeKey).toBe(records[2]?.dedupeKey);
  expect(records[0]?.dedupeKey).not.toBe(records[1]?.dedupeKey);
  const multi = shutdown();
  expect(
    parse([
      start,
      {
        ...multi,
        data: {
          ...multi.data,
          modelMetrics: {
            ...multi.data.modelMetrics,
            "gpt-5.5": { usage: { inputTokens: 100, outputTokens: 50 }, totalNanoAiu: 0 },
            empty: { usage: { inputTokens: 0 } },
            invalid: null,
          },
        },
      },
    ]).map((record) => [record.model, record.reportedCostUsd]),
  ).toEqual([
    ["claude-opus-4.8", null],
    ["gpt-5.5", null],
  ]);
});

it("reads durable per-call usage before shutdown and excludes the matching shutdown rollup", () => {
  const completed = shutdown();
  const call = {
    type: "session.usage_record",
    id: "usage-1",
    timestamp: "2026-11-01T09:59:00Z",
    data: {
      usage: {
        model: "auto",
        responseModel: "claude-opus-4.8",
        ...completed.data.modelMetrics["claude-opus-4.8"].usage,
        accounting: { sourceSessionId: "session-1", sequence: 1 },
        copilotUsage: { totalNanoAiu: 27_166_150_000 },
      },
    },
  };
  const [record] = parse([start, call]);
  expect(record).toMatchObject({
    provider: "copilot",
    model: "claude-opus-4.8",
    rateModel: "claude-opus-4-8",
    timestampMs: Date.parse(call.timestamp),
    reportedCostUsd: null,
    totals: parse([start, completed])[0]?.totals,
  });
  expect(parse([start, call, completed])).toEqual([record]);
  expect(
    parse([
      start,
      {
        ...call,
        data: { usage: { ...call.data.usage, model: "claude-opus-4.8", responseModel: "" } },
      },
    ]),
  ).toEqual([record]);
  expect(parse([start, call, { ...call, id: "copied" }]).map((entry) => entry.dedupeKey)).toEqual([
    record?.dedupeKey,
    record?.dedupeKey,
  ]);
  expect(
    parse([
      start,
      call,
      completed,
      { type: "session.resume", data: {} },
      { ...completed, id: "old-runtime" },
    ]),
  ).toHaveLength(2);
});

it("uses model pricing regardless of AI credits or legacy premium request counts", () => {
  const event = shutdown();
  for (const totalNanoAiu of [undefined, 0, 1_000_000_000, null, -1, "1000000000"]) {
    const records = parse([
      start,
      {
        ...event,
        data: {
          ...event.data,
          modelMetrics: {
            "claude-opus-4.8": { ...event.data.modelMetrics["claude-opus-4.8"], totalNanoAiu },
          },
        },
      },
    ]);
    expect(records[0]?.reportedCostUsd).toBeNull();
  }
});

it("ignores partial history, checkpoints, message counters, and invalid records", () => {
  expect(parse([shutdown()])).toEqual([]);
  expect(
    copilotUsageFormat.parseLine("{broken", { sessionId: "session-1", hasUsageRecords: false }),
  ).toEqual([]);
  expect(
    parse([
      start,
      null,
      { ...shutdown(), timestamp: "invalid" },
      { ...shutdown(), id: "" },
      { type: "session.usage_checkpoint", data: { totalNanoAiu: 27_166_150_000 } },
      { type: "assistant.message", data: { outputTokens: 100 } },
      { type: "session.shutdown", id: "empty", timestamp: shutdown().timestamp, data: {} },
    ]),
  ).toEqual([]);
  const event = shutdown();
  const state = copilotUsageFormat.state!.initial();
  copilotUsageFormat.parseProjected(start, state);
  const restored = decodeState(encodeState(state));
  expect(copilotUsageFormat.parseProjected(event, restored)).toEqual(parse([start, event]));
});

it.effect(
  "discovers default, configured, and local Copilot homes without scanning other ACP agents",
  () =>
    Effect.gen(function* () {
      const directories =
        copilotUsageReader.kind === "transcripts" && copilotUsageReader.directories;
      if (!directories) throw new Error("Expected a transcript reader");
      const instance = {
        instanceId: ProviderInstanceId.make("copilot"),
        configured: true,
        config: decodeSettings({ agentId: "github-copilot-cli" }),
        environment: {},
      };
      expect(yield* directories(instance)).toEqual([
        { dir: "/home/test/.copilot/session-state", fileName: "events.jsonl" },
      ]);
      expect(
        yield* directories({ ...instance, environment: { COPILOT_HOME: "~/copilot-work" } }),
      ).toEqual([{ dir: "/home/test/copilot-work/session-state", fileName: "events.jsonl" }]);
      for (const commandArgs of [["--config-dir", "~/override"], ["--config-dir=~/override"]]) {
        expect(
          yield* directories({
            ...instance,
            environment: { COPILOT_HOME: "/ignored" },
            config: {
              ...instance.config,
              source: "local",
              commandPath: "copilot",
              commandArgs,
              enabled: false,
            },
          }),
        ).toEqual([{ dir: "/home/test/override/session-state", fileName: "events.jsonl" }]);
      }
      expect(
        yield* directories({
          ...instance,
          config: { ...instance.config, source: "local", agentId: "", commandPath: "/bin/copilot" },
        }),
      ).toHaveLength(1);
      expect(
        yield* directories({ ...instance, config: { ...instance.config, agentId: "devin" } }),
      ).toEqual([]);
      expect(yield* directories({ ...instance, config: undefined })).toEqual([]);
      expect(
        yield* directories({ ...instance, configured: false, config: undefined }),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    ),
);

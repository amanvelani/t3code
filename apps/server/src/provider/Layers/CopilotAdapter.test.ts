import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import {
  CopilotSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeCopilotSdkClient, type CopilotSdkClient } from "../sdk/CopilotSdkClient.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

vi.mock("../sdk/CopilotSdkClient.ts", () => ({ makeCopilotSdkClient: vi.fn() }));

const decodeSettings = Schema.decodeUnknownEffect(CopilotSettings);
const threadId = ThreadId.make("copilot-follow-up-test");
const instanceId = ProviderInstanceId.make("copilot");
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-copilot-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const sent = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  let onEvent: SessionConfig["onEvent"];
  const send = vi.fn<CopilotSession["send"]>(async () => {
    Queue.offerUnsafe(sent, undefined);
    return "message-id";
  });
  const setModel = vi.fn<CopilotSession["setModel"]>(async () => {});
  const listSkills = vi.fn<CopilotSession["rpc"]["skills"]["list"]>(async () => ({ skills: [] }));
  const invokeCommand = vi.fn<CopilotSession["rpc"]["commands"]["invoke"]>(async () => ({
    kind: "agent-prompt",
    prompt: "expanded skill prompt",
    displayPrompt: "/skill",
  }));
  // Only the SDK methods exercised by these adapter tests are implemented.
  const session = {
    sessionId: "sdk-session",
    send,
    setModel,
    disconnect: async () => {},
    rpc: {
      skills: { list: listSkills },
      commands: { invoke: invokeCommand },
    },
  } as unknown as CopilotSession;
  vi.mocked(makeCopilotSdkClient).mockReturnValue(
    Effect.succeed({
      createSession: (config: SessionConfig) => {
        onEvent = config.onEvent;
        return Effect.succeed(session);
      },
    } as unknown as CopilotSdkClient),
  );
  const settings = yield* decodeSettings({});
  const adapter = yield* makeCopilotAdapter(settings);
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
  const emitIdle = () =>
    onEvent?.({
      id: "idle-event",
      timestamp: "2026-09-04T00:00:00.000Z",
      parentId: null,
      type: "session.idle",
      data: {},
    } as SessionEvent);
  const nextCompleted = Queue.take(events).pipe(
    Effect.repeat({ until: (event) => event.type === "turn.completed" }),
  );
  return {
    adapter,
    send,
    setModel,
    listSkills,
    invokeCommand,
    sent,
    events,
    emitIdle,
    nextCompleted,
  };
});

it.layer(layer)("CopilotAdapter follow-ups", (it) => {
  it.effect("steers the active turn and completes it once before admitting a fresh turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Start working" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.sent);
      const activeTurnId = (yield* h.adapter.listSessions())[0]!.activeTurnId;
      const followUp = yield* h.adapter.sendTurn({
        threadId,
        input: "Focus on tests",
        interactionMode: "plan",
        modelSelection: { instanceId, model: "another-model" },
      });
      expect(followUp.turnId).toBe(activeTurnId);
      expect(h.send).toHaveBeenLastCalledWith({
        prompt: "Focus on tests",
        agentMode: "plan",
        mode: "immediate",
      });
      expect(h.setModel).not.toHaveBeenCalled();
      expect((yield* h.adapter.listSessions())[0]!.activeTurnId).toBe(activeTurnId);
      yield* Queue.take(h.sent);
      h.emitIdle();
      expect((yield* Fiber.join(first)).turnId).toBe(activeTurnId);
      const completed = yield* h.nextCompleted;
      expect(completed.turnId).toBe(activeTurnId);
      expect(completed.payload).toEqual({ state: "completed", stopReason: null });
      expect((yield* h.adapter.listSessions())[0]!.activeTurnId).toBeUndefined();
      expect(yield* Queue.size(h.events)).toBe(0);

      const next = yield* h.adapter
        .sendTurn({ threadId, input: "Next task" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.sent);
      h.emitIdle();
      expect((yield* Fiber.join(next)).turnId).not.toBe(activeTurnId);
    }),
  );

  it.effect("a failed follow-up preserves the active turn and allows another follow-up", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Start working" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.sent);
      const activeTurnId = (yield* h.adapter.listSessions())[0]!.activeTurnId;
      h.send.mockRejectedValueOnce(new Error("send failed"));
      const error = yield* h.adapter.sendTurn({ threadId, input: "Follow up" }).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect((yield* h.adapter.listSessions())[0]!.activeTurnId).toBe(activeTurnId);
      const retry = yield* h.adapter.sendTurn({ threadId, input: "Try again" });
      expect(retry.turnId).toBe(activeTurnId);
      h.emitIdle();
      yield* Fiber.join(first);
      expect((yield* h.nextCompleted).payload).toEqual({ state: "completed", stopReason: null });
    }),
  );

  it.effect("rejects an empty follow-up without sending it or clearing the active turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Start working" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.sent);
      const error = yield* h.adapter.sendTurn({ threadId, input: "  " }).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(h.send).toHaveBeenCalledTimes(1);
      h.emitIdle();
      yield* Fiber.join(first);
    }),
  );

  it.effect("expands a selected skill through Copilot's native command API", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.listSkills.mockResolvedValueOnce({
        skills: [
          {
            name: "brainstorm",
            commandName: "superpowers:brainstorm",
            description: "Explore the problem.",
            source: "plugin",
            userInvocable: true,
            enabled: true,
            path: "/skills/brainstorm.md",
          },
        ],
      });
      const turn = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Use $superpowers:brainstorm for this feature",
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.sent);

      expect(h.invokeCommand).toHaveBeenCalledWith({
        name: "superpowers:brainstorm",
        input: "Use\nfor this feature",
      });
      expect(h.send).toHaveBeenCalledWith({
        prompt: "expanded skill prompt",
        agentMode: "interactive",
      });

      h.emitIdle();
      yield* Fiber.join(turn);
    }),
  );
});

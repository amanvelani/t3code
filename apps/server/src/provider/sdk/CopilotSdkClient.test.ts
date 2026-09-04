// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { expect, vi } from "vite-plus/test";

import { openCopilotSdkSession, resolveCopilotBinaryPath } from "./CopilotSdkClient.ts";

// A name that can't exist in the machine's real PATH / common install dirs, so
// these tests only see the executables they create and don't pick up a
// brew/npm-installed `copilot`.
const BIN = "copilot-resolver-test-bin";

async function makeExecutable(dir: string, name: string): Promise<string> {
  const filePath = NodePath.join(dir, name);
  await NodeFSP.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await NodeFSP.chmod(filePath, 0o755);
  return filePath;
}

describe("resolveCopilotBinaryPath", () => {
  it("returns an explicit path (containing a separator) verbatim", async () => {
    const explicit = NodePath.join("/opt", "custom", BIN);
    const resolved = await resolveCopilotBinaryPath(explicit, {});
    assert.strictEqual(resolved, explicit);
  });

  it("resolves a bare name against the spawn env PATH", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-resolve-"));
    const expected = await makeExecutable(dir, BIN);
    const resolved = await resolveCopilotBinaryPath(BIN, { PATH: dir });
    assert.strictEqual(resolved, expected);
  });

  it("skips a directory named like the binary and resolves a real file later in PATH", async () => {
    const shadowDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-shadow-"));
    const realDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-real-"));
    // A directory named like the binary earlier in PATH must not shadow the CLI.
    await NodeFSP.mkdir(NodePath.join(shadowDir, BIN));
    const expected = await makeExecutable(realDir, BIN);
    const resolved = await resolveCopilotBinaryPath(BIN, {
      PATH: `${shadowDir}${NodePath.delimiter}${realDir}`,
    });
    assert.strictEqual(resolved, expected);
  });

  it("falls back to the bare name when nothing resolves", async () => {
    const emptyDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-empty-"));
    const resolved = await resolveCopilotBinaryPath(BIN, { PATH: emptyDir });
    assert.strictEqual(resolved, BIN);
  });
});

describe("openCopilotSdkSession", () => {
  const makeSession = () => {
    const setModel = vi.fn(async () => {});
    const disconnect = vi.fn(async () => {});
    return { setModel, disconnect, session: { setModel, disconnect } as unknown as CopilotSession };
  };

  it("opens HydraFusion without a catalog model, then selects it before returning", async () => {
    const h = makeSession();
    const open = vi.fn(async (_config: SessionConfig) => h.session);
    const config: SessionConfig = {
      model: "hydrafusion-max",
      enableExperimentalMode: true,
      workingDirectory: "/tmp",
      reasoningEffort: "high",
    };
    assert.strictEqual(await openCopilotSdkSession(config, open), h.session);
    assert.strictEqual(open.mock.calls[0]?.[0].model, undefined);
    assert.strictEqual(open.mock.calls[0]?.[0].reasoningEffort, undefined);
    assert.strictEqual(open.mock.calls[0]?.[0].enableExperimentalMode, true);
    assert.deepStrictEqual(h.setModel.mock.calls, [["hydrafusion-max"]]);
  });

  it("leaves ordinary model creation unchanged", async () => {
    const h = makeSession();
    const config: SessionConfig = { model: "gpt-5.4" };
    const open = vi.fn(async (_config: SessionConfig) => h.session);
    await openCopilotSdkSession(config, open);
    assert.strictEqual(open.mock.calls[0]?.[0], config);
    assert.strictEqual(h.setModel.mock.calls.length, 0);
  });

  it("requires explicit experimental opt-in", async () => {
    const h = makeSession();
    const open = vi.fn(async (_config: SessionConfig) => h.session);
    await expect(openCopilotSdkSession({ model: "hydrafusion-max" }, open)).rejects.toThrow(
      /Experimental features/,
    );
    assert.strictEqual(open.mock.calls.length, 0);
  });

  it("disconnects instead of silently falling back when the runtime rejects HydraFusion", async () => {
    const h = makeSession();
    h.setModel.mockRejectedValueOnce(new Error("not available"));
    await expect(
      openCopilotSdkSession(
        { model: "hydrafusion-max", enableExperimentalMode: true },
        async () => h.session,
      ),
    ).rejects.toThrow(/not available/);
    assert.strictEqual(h.disconnect.mock.calls.length, 1);
  });
});

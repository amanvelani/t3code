import { AcpRegistryOperationError, ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";

import type { CopilotSdkInspectionClient } from "./copilotSdk.ts";
import { logoutAcpRegistry, probeAcpRegistryConfiguration } from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

const mockProbeLayer = Layer.mergeAll(
  Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make((size) => new Uint8Array(size)),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
  resolved?: AcpRegistrySupport.ResolvedAcpRegistryAgent,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => (resolved ? Effect.succeed(resolved) : Effect.die("unused resolve")),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).models,
    ).toEqual(provider.models);

    const liveOptions = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
        currentValue: "high",
      },
    ];
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: liveOptions },
        [],
      ).models,
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );

  it("reports authenticated status and discovered models for Copilot SDK", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "github-copilot-cli",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [
            { id: "claude-sonnet-4.5", name: "Claude 3.5 Sonnet", description: null },
            { id: "gpt-4o", name: "GPT-4o", description: null },
          ],
          currentModelId: "claude-sonnet-4.5",
          configOptions: [],
          sessionManagement: {
            ...noSessionManagement,
            canLogout: false,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot).toMatchObject({
      installed: true,
      status: "ready",
      auth: {
        status: "authenticated",
        label: "GitHub Copilot",
        canLogout: false,
      },
      models: [
        expect.objectContaining({ slug: "claude-sonnet-4.5", isDefault: true }),
        expect.objectContaining({ slug: "gpt-4o" }),
      ],
    });
  });

  it("reports unauthenticated status with terminal sign-in for Copilot SDK probe failure", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "github-copilot-cli",
        version: "1.0.0",
        distribution: "binary",
      },
      probeError: new AcpRegistryOperationError({
        reason: "authentication_failed",
        message:
          "GitHub Copilot is not authenticated. Sign in with 'copilot login' or in provider settings.",
        authMethods: [
          {
            id: "copilot-login",
            name: "GitHub Copilot sign in",
            description: "Sign in with your GitHub account using the Copilot CLI in a terminal.",
            type: "terminal",
            command: "copilot login",
          },
        ],
      }),
    });

    expect(snapshot).toMatchObject({
      installed: true,
      status: "warning",
      auth: {
        status: "unauthenticated",
        type: "terminal",
        label: "GitHub Copilot sign in",
      },
      message:
        'Sign in in provider settings using "GitHub Copilot sign in". The login terminal runs on this environment.',
    });
  });

  it.effect("probes Copilot SDK and reports authentication failure when unauthenticated", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
      const mockClient = {
        start: async () => {},
        stop: async () => {},
        getAuthStatus: async () => ({ isAuthenticated: false, statusMessage: "Not signed in" }),
        listModels: async () => [],
      } as unknown as CopilotSdkInspectionClient;

      const result = yield* probeAcpRegistryConfiguration(
        {
          instanceId: identity.instanceId,
          settings,
          cwd: "/workspace",
          environment: {},
        },
        {
          makeCopilotSdkClient: () => Promise.resolve(mockClient),
        },
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection(
            {
              status: "ready",
              agentId: "github-copilot-cli",
              version: "1.0.0",
              distribution: "binary",
            },
            {
              distribution: "binary",
              spawn: { command: "copilot", args: [] },
            },
          ),
        ),
        Effect.provide(mockProbeLayer),
        Effect.flip,
      );

      expect(result).toMatchObject({
        reason: "authentication_failed",
        authMethods: [
          expect.objectContaining({
            id: "copilot-login",
            type: "terminal",
            command: "copilot login",
          }),
        ],
      });
    }),
  );

  it.effect("probes Copilot SDK and reports discovered models when authenticated", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
      const mockClient = {
        start: async () => {},
        stop: async () => {},
        getAuthStatus: async () => ({ isAuthenticated: true, login: "aman" }),
        listModels: async () => [
          { id: "auto", name: "Auto" },
          { id: "claude-sonnet-4.5", name: "Claude 3.5 Sonnet" },
          { id: "gpt-4o", name: "GPT-4o" },
        ],
        getModelCatalog: async () => ({
          models: [
            { id: "auto", name: "Auto" },
            { id: "claude-sonnet-4.5", name: "Claude 3.5 Sonnet" },
            { id: "gpt-4o", name: "GPT-4o" },
          ],
          auto: {
            defaultTier: "balance",
            tiers: [
              {
                id: "balance",
                displayName: "Standard",
                description: "Prioritizes versatile models for efficient everyday coding.",
                type: "auto",
                fusionTier: "standard",
                status: { enabled: true, pickerVisible: true },
              },
              {
                id: "hydrafusion",
                displayName: "High",
                description:
                  "Prioritizes capable models for challenging tasks and deeper reasoning.",
                type: "fusion",
                fusionTier: "high",
                status: { enabled: true, pickerVisible: true },
              },
              {
                id: "hydrafusion-max",
                displayName: "Max",
                description:
                  "Prioritizes the most capable models for the most demanding tasks and complex reasoning.",
                type: "fusion",
                fusionTier: "max",
                status: { enabled: true, pickerVisible: true },
              },
              {
                id: "fast",
                displayName: "Fast",
                type: "auto",
                status: { enabled: true, pickerVisible: false },
              },
              {
                id: "disabled-tier",
                displayName: "Disabled",
                type: "fusion",
                fusionTier: "disabled",
                status: { enabled: false, pickerVisible: true },
              },
              {
                id: "unknown-type",
                displayName: "Unknown Type",
                type: "other",
                status: { enabled: true, pickerVisible: true },
              },
            ],
          },
        }),
      } as unknown as CopilotSdkInspectionClient;

      const result = yield* probeAcpRegistryConfiguration(
        {
          instanceId: identity.instanceId,
          settings,
          cwd: "/workspace",
          environment: {},
        },
        {
          makeCopilotSdkClient: () => Promise.resolve(mockClient),
        },
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection(
            {
              status: "ready",
              agentId: "github-copilot-cli",
              version: "1.0.0",
              distribution: "binary",
            },
            {
              distribution: "binary",
              spawn: { command: "copilot", args: [] },
            },
          ),
        ),
        Effect.provide(mockProbeLayer),
      );

      expect(result.probe).toMatchObject({
        ready: true,
        models: [
          { id: "auto", name: "Auto", description: null },
          {
            id: '{"model":"auto","autoTier":"balance"}',
            name: "Copilot Fusion Standard",
            description: "Prioritizes versatile models for efficient everyday coding.",
          },
          {
            id: '{"model":"auto","autoTier":"hydrafusion"}',
            name: "Copilot Fusion High",
            description: "Prioritizes capable models for challenging tasks and deeper reasoning.",
          },
          {
            id: '{"model":"auto","autoTier":"hydrafusion-max"}',
            name: "Copilot Fusion Max",
            description:
              "Prioritizes the most capable models for the most demanding tasks and complex reasoning.",
          },
          { id: "claude-sonnet-4.5", name: "Claude 3.5 Sonnet", description: null },
          { id: "gpt-4o", name: "GPT-4o", description: null },
        ],
        currentModelId: "auto",
      });
      expect(result.probe.models).toHaveLength(6);
    }),
  );

  it.effect(
    "probes Copilot SDK and surfaces error when getAuthStatus throws (does not report unauthenticated)",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
        const mockClient = {
          start: async () => {},
          stop: async () => [],
          getAuthStatus: async () => {
            throw new Error("CLI process exited unexpectedly with code 1");
          },
          listModels: async () => [],
        } as unknown as CopilotSdkInspectionClient;

        const result = yield* probeAcpRegistryConfiguration(
          {
            instanceId: identity.instanceId,
            settings,
            cwd: "/workspace",
            environment: {},
          },
          {
            makeCopilotSdkClient: () => Promise.resolve(mockClient),
          },
        ).pipe(
          Effect.provideService(
            AcpRegistrySupport.AcpRegistryCatalog,
            catalogWithInspection(
              {
                status: "ready",
                agentId: "github-copilot-cli",
                version: "1.0.0",
                distribution: "binary",
              },
              {
                distribution: "binary",
                spawn: { command: "copilot", args: [] },
              },
            ),
          ),
          Effect.provide(mockProbeLayer),
          Effect.flip,
        );

        expect(result.reason).toBe("probe_failed");
        expect(result.message).toContain("Could not check GitHub Copilot authentication status");
      }),
  );

  it.effect(
    "probes Copilot SDK and surfaces error when getModelCatalog throws (does not fabricate Auto)",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
        const mockClient = {
          start: async () => {},
          stop: async () => [],
          getAuthStatus: async () => ({ isAuthenticated: true }),
          listModels: async () => {
            throw new Error("Failed to list models");
          },
          getModelCatalog: async () => {
            throw new Error("Failed to list models");
          },
        } as unknown as CopilotSdkInspectionClient;

        const result = yield* probeAcpRegistryConfiguration(
          {
            instanceId: identity.instanceId,
            settings,
            cwd: "/workspace",
            environment: {},
          },
          {
            makeCopilotSdkClient: () => Promise.resolve(mockClient),
          },
        ).pipe(
          Effect.provideService(
            AcpRegistrySupport.AcpRegistryCatalog,
            catalogWithInspection(
              {
                status: "ready",
                agentId: "github-copilot-cli",
                version: "1.0.0",
                distribution: "binary",
              },
              {
                distribution: "binary",
                spawn: { command: "copilot", args: [] },
              },
            ),
          ),
          Effect.provide(mockProbeLayer),
          Effect.flip,
        );

        expect(result.reason).toBe("probe_failed");
        expect(result.message).toContain("Could not retrieve GitHub Copilot models");
      }),
  );

  it.effect(
    "probes Copilot SDK and surfaces error when getModelCatalog returns empty (does not fabricate Auto)",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
        const mockClient = {
          start: async () => {},
          stop: async () => [],
          getAuthStatus: async () => ({ isAuthenticated: true }),
          listModels: async () => [],
          getModelCatalog: async () => ({ models: [] }),
        } as unknown as CopilotSdkInspectionClient;

        const result = yield* probeAcpRegistryConfiguration(
          {
            instanceId: identity.instanceId,
            settings,
            cwd: "/workspace",
            environment: {},
          },
          {
            makeCopilotSdkClient: () => Promise.resolve(mockClient),
          },
        ).pipe(
          Effect.provideService(
            AcpRegistrySupport.AcpRegistryCatalog,
            catalogWithInspection(
              {
                status: "ready",
                agentId: "github-copilot-cli",
                version: "1.0.0",
                distribution: "binary",
              },
              {
                distribution: "binary",
                spawn: { command: "copilot", args: [] },
              },
            ),
          ),
          Effect.provide(mockProbeLayer),
          Effect.flip,
        );

        expect(result.reason).toBe("probe_failed");
        expect(result.message).toContain("did not return any available models");
      }),
  );

  it.effect("honors resolved.spawn.env when probing Copilot SDK", () =>
    Effect.gen(function* () {
      let passedEnv: NodeJS.ProcessEnv | undefined;
      const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
      const mockClient = {
        start: async () => {},
        stop: async () => [],
        getAuthStatus: async () => ({ isAuthenticated: true }),
        listModels: async () => [{ id: "m1", name: "Model 1" }],
        getModelCatalog: async () => ({ models: [{ id: "m1", name: "Model 1" }] }),
      } as unknown as CopilotSdkInspectionClient;

      yield* probeAcpRegistryConfiguration(
        {
          instanceId: identity.instanceId,
          settings,
          cwd: "/workspace",
          environment: { BASE_ENV: "base" },
        },
        {
          makeCopilotSdkClient: (options) => {
            passedEnv = options.env;
            return Promise.resolve(mockClient);
          },
        },
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection(
            {
              status: "ready",
              agentId: "github-copilot-cli",
              version: "1.0.0",
              distribution: "binary",
            },
            {
              distribution: "binary",
              spawn: {
                command: "copilot",
                args: [],
                env: { COPILOT_HOME: "/custom/copilot", SPAWN_ENV: "spawn" },
              },
            },
          ),
        ),
        Effect.provide(mockProbeLayer),
      );

      expect(passedEnv).toMatchObject({
        BASE_ENV: "base",
        COPILOT_HOME: "/custom/copilot",
        SPAWN_ENV: "spawn",
        ELECTRON_RUN_AS_NODE: "1",
      });
    }),
  );

  it.effect("logoutAcpRegistry fails cleanly with unsupported for Copilot SDK", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "github-copilot-cli", copilotSdk: true });
      const result = yield* logoutAcpRegistry({
        instanceId: identity.instanceId,
        settings,
        cwd: "/workspace",
        environment: {},
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "github-copilot-cli",
            version: "1.0.0",
            distribution: "binary",
          }),
        ),
        Effect.provide(mockProbeLayer),
        Effect.flip,
      );

      expect(result.reason).toBe("logout_unsupported");
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import {
  buildCopilotDiscoveredModels,
  copilotSdkRuntimeEnvironment,
  encodeCopilotFusionModelId,
  formatCopilotFusionDisplayName,
  parseCopilotModelSelection,
} from "./copilotModel.ts";

describe("copilotModel helper", () => {
  it("encodes and decodes fusion model IDs and plain models", () => {
    const encoded = encodeCopilotFusionModelId("hydrafusion");
    expect(encoded).toBe('{"model":"auto","autoTier":"hydrafusion"}');

    const parsedFusion = parseCopilotModelSelection(encoded);
    expect(parsedFusion).toEqual({
      selectionModel: encoded,
      runtimeModel: "auto",
      autoTier: "hydrafusion",
      isFusion: true,
    });

    const parsedPlain = parseCopilotModelSelection("auto");
    expect(parsedPlain).toEqual({
      selectionModel: "auto",
      runtimeModel: "auto",
      autoTier: undefined,
      isFusion: false,
    });

    const parsedOrdinary = parseCopilotModelSelection("claude-sonnet-4.5");
    expect(parsedOrdinary).toEqual({
      selectionModel: "claude-sonnet-4.5",
      runtimeModel: "claude-sonnet-4.5",
      autoTier: undefined,
      isFusion: false,
    });
  });

  it("throws on malformed JSON model selections without silent routing", () => {
    expect(() => parseCopilotModelSelection("{invalid json")).toThrow();
    expect(() => parseCopilotModelSelection('{"model":"other","autoTier":"test"}')).toThrow();
    expect(() => parseCopilotModelSelection('{"model":"auto","autoTier":""}')).toThrow();
    expect(() => parseCopilotModelSelection('{"model":"auto"}')).toThrow();
  });

  it("formats fusion display names correctly", () => {
    expect(
      formatCopilotFusionDisplayName({
        id: "balance",
        displayName: "Standard",
        fusionTier: "standard",
      }),
    ).toBe("Copilot Fusion Standard");
    expect(
      formatCopilotFusionDisplayName({
        id: "hydrafusion",
        displayName: "Copilot Fusion High",
      }),
    ).toBe("Copilot Fusion High");
    expect(
      formatCopilotFusionDisplayName({
        id: "hydrafusion-max",
        fusionTier: "max",
      }),
    ).toBe("Copilot Fusion Max");
  });

  it("builds discovered models preserving order, exact opaque IDs, and filtering invalid tiers", () => {
    const catalog = {
      models: [
        { id: "auto", name: "Auto" },
        { id: "gpt-4o", name: "GPT-4o" },
      ],
      auto: {
        defaultTier: "balance",
        tiers: [
          {
            id: "balance",
            displayName: "Standard",
            description: "Standard everyday coding",
            type: "auto",
            fusionTier: "standard",
            status: { enabled: true, pickerVisible: true },
          },
          {
            id: "hydrafusion",
            displayName: "High",
            description: "Deeper reasoning",
            type: "fusion",
            fusionTier: "high",
            status: { enabled: true, pickerVisible: true },
          },
          {
            id: "fast",
            displayName: "Fast",
            type: "auto",
            status: { enabled: true, pickerVisible: false },
          },
          {
            id: "disabled",
            displayName: "Disabled",
            type: "fusion",
            status: { enabled: false, pickerVisible: true },
          },
          {
            id: "unknown",
            displayName: "Unknown",
            type: "experimental-type",
            status: { enabled: true, pickerVisible: true },
          },
        ],
      },
    };

    const discovered = buildCopilotDiscoveredModels(catalog);
    expect(discovered).toEqual([
      { id: "auto", name: "Auto", description: null },
      {
        id: '{"model":"auto","autoTier":"balance"}',
        name: "Copilot Fusion Standard",
        description: "Standard everyday coding",
      },
      {
        id: '{"model":"auto","autoTier":"hydrafusion"}',
        name: "Copilot Fusion High",
        description: "Deeper reasoning",
      },
      { id: "gpt-4o", name: "GPT-4o", description: null },
    ]);
  });

  it("preserves ordinary models when auto metadata is absent without fabricating Fusion", () => {
    const catalog = {
      models: [
        { id: "auto", name: "Auto" },
        { id: "gpt-4o", name: "GPT-4o" },
      ],
    };
    const discovered = buildCopilotDiscoveredModels(catalog);
    expect(discovered).toEqual([
      { id: "auto", name: "Auto", description: null },
      { id: "gpt-4o", name: "GPT-4o", description: null },
    ]);
  });

  it("configures runtime environment with required feature flags and preserves explicit disable", () => {
    const env1 = copilotSdkRuntimeEnvironment({ BASE_VAR: "1" });
    expect(env1.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env1.COPILOT_CLI_ENABLED_FEATURE_FLAGS).toBe("DYNAMIC_AUTO_TIERS,HYDRAFUSION_PLAN_V2");

    const env2 = copilotSdkRuntimeEnvironment({
      COPILOT_CLI_ENABLED_FEATURE_FLAGS: "CUSTOM_FLAG",
    });
    expect(env2.COPILOT_CLI_ENABLED_FEATURE_FLAGS).toBe(
      "CUSTOM_FLAG,DYNAMIC_AUTO_TIERS,HYDRAFUSION_PLAN_V2",
    );

    const env3 = copilotSdkRuntimeEnvironment({
      COPILOT_CLI_DISABLED_FEATURE_FLAGS: "DYNAMIC_AUTO_TIERS",
    });
    expect(env3.COPILOT_CLI_ENABLED_FEATURE_FLAGS).toBe("HYDRAFUSION_PLAN_V2");
  });
});

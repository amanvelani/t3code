export interface DiscoveredCopilotModel {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface CopilotParsedModelSelection {
  readonly selectionModel: string;
  readonly runtimeModel: string;
  readonly autoTier: string | undefined;
  readonly isFusion: boolean;
}

export function encodeCopilotFusionModelId(tierId: string): string {
  return JSON.stringify({ model: "auto", autoTier: tierId });
}

export function parseCopilotModelSelection(modelSelection: string): CopilotParsedModelSelection {
  if (modelSelection.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(modelSelection);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        "model" in parsed &&
        "autoTier" in parsed
      ) {
        const model = (parsed as { model: unknown }).model;
        const autoTier = (parsed as { autoTier: unknown }).autoTier;
        if (model === "auto" && typeof autoTier === "string" && autoTier.trim().length > 0) {
          return {
            selectionModel: modelSelection,
            runtimeModel: "auto",
            autoTier: autoTier.trim(),
            isFusion: true,
          };
        }
      }
      throw new Error(`Malformed Copilot model selection: ${modelSelection}`);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Malformed")) {
        throw cause;
      }
      throw new Error(`Invalid Copilot model selection: ${modelSelection}`, { cause });
    }
  }

  const trimmed = modelSelection.trim();
  return {
    selectionModel: modelSelection,
    runtimeModel: trimmed,
    autoTier: undefined,
    isFusion: false,
  };
}

export function formatCopilotFusionDisplayName(descriptor: {
  readonly id: string;
  readonly displayName?: string;
  readonly fusionTier?: string;
}): string {
  const name =
    descriptor.displayName?.trim() ||
    (descriptor.fusionTier
      ? descriptor.fusionTier.charAt(0).toUpperCase() + descriptor.fusionTier.slice(1)
      : descriptor.id);
  if (/^copilot fusion\b/i.test(name)) {
    return name;
  }
  return `Copilot Fusion ${name}`;
}

export function buildCopilotDiscoveredModels(catalog: {
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly name?: string;
    readonly description?: string | null;
  }>;
  readonly auto?: {
    readonly defaultTier?: string;
    readonly tiers?: ReadonlyArray<{
      readonly id: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly type?: string;
      readonly fusionTier?: string;
      readonly status?: {
        readonly enabled?: boolean;
        readonly pickerVisible?: boolean;
      };
    }>;
  };
}): ReadonlyArray<DiscoveredCopilotModel> {
  const ordinaryModels: Array<DiscoveredCopilotModel> = catalog.models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: m.description ?? null,
  }));

  const rawTiers = catalog.auto?.tiers;
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
    return ordinaryModels;
  }

  const fusionModels: Array<DiscoveredCopilotModel> = [];
  for (const tier of rawTiers) {
    if (tier.status?.enabled !== true) {
      continue;
    }
    if (tier.status?.pickerVisible === false) {
      continue;
    }
    const executionType = tier.type?.toLowerCase();
    if (executionType !== "auto" && executionType !== "fusion") {
      continue;
    }
    const opaqueId = tier.id?.trim();
    if (!opaqueId) {
      continue;
    }

    fusionModels.push({
      id: encodeCopilotFusionModelId(opaqueId),
      name: formatCopilotFusionDisplayName(tier),
      description: tier.description?.trim() || null,
    });
  }

  if (fusionModels.length === 0) {
    return ordinaryModels;
  }

  const autoIndex = ordinaryModels.findIndex((m) => m.id === "auto");
  if (autoIndex >= 0) {
    return [
      ...ordinaryModels.slice(0, autoIndex + 1),
      ...fusionModels,
      ...ordinaryModels.slice(autoIndex + 1),
    ];
  }

  return [...fusionModels, ...ordinaryModels];
}

const REQUIRED_COPILOT_FEATURE_FLAGS = ["DYNAMIC_AUTO_TIERS", "HYDRAFUSION_PLAN_V2"] as const;

export function copilotSdkRuntimeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  const existingEnabled = baseEnvironment.COPILOT_CLI_ENABLED_FEATURE_FLAGS ?? "";
  const existingDisabled = baseEnvironment.COPILOT_CLI_DISABLED_FEATURE_FLAGS ?? "";

  const disabledSet = new Set(
    existingDisabled
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
  );

  const enabledFlags = new Set(
    existingEnabled
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
  );

  for (const flag of REQUIRED_COPILOT_FEATURE_FLAGS) {
    if (!disabledSet.has(flag) && !enabledFlags.has(`-${flag}`) && !enabledFlags.has(`!${flag}`)) {
      enabledFlags.add(flag);
    }
  }

  result.ELECTRON_RUN_AS_NODE = "1";
  result.COPILOT_CLI_ENABLED_FEATURE_FLAGS = [...enabledFlags].join(",");

  return result;
}

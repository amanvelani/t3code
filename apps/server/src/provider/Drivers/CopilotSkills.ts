import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { makeCopilotSdkClient, type CopilotSdkServerSkill } from "../sdk/CopilotSdkClient.ts";

const COPILOT_SKILLS_START_TIMEOUT_MS = 5_000;

function normalizeSkillScope(source: CopilotSdkServerSkill["source"]): string {
  switch (source) {
    case "project":
    case "inherited":
      return "project";
    case "personal-copilot":
    case "personal-agents":
      return "personal";
    case "builtin":
      return "system";
    default:
      return source;
  }
}

/** Map the Copilot runtime's native inventory onto T3's provider skill contract. */
export function copilotSdkSkillsToServerProviderSkills(
  skills: ReadonlyArray<CopilotSdkServerSkill>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.flatMap((skill) => {
    const name = skill.commandName?.trim() || skill.name.trim();
    const path = skill.path?.trim();
    if (!name || !path) return [];

    const description = skill.description.trim();
    const displayName = skill.name.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        path,
        scope: normalizeSkillScope(skill.source),
        enabled: skill.enabled,
        ...(displayName && displayName !== name ? { displayName } : {}),
        userInvocable: skill.userInvocable,
      },
    ];
  });
}

/**
 * Ask the Copilot runtime for the inventory it would load for `cwd`. Discovery
 * is best-effort so an older runtime cannot make the provider unavailable.
 */
export const discoverCopilotSkills = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, never> =>
  makeCopilotSdkClient({
    binaryPath,
    environment,
    startTimeoutMs: COPILOT_SKILLS_START_TIMEOUT_MS,
  }).pipe(
    Effect.flatMap((client) => client.discoverSkills(cwd)),
    Effect.map((result) => copilotSdkSkillsToServerProviderSkills(result.skills)),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("Copilot SDK skill discovery failed", {
            cause: Cause.pretty(cause),
            cwd,
          }).pipe(Effect.as([] as ReadonlyArray<ServerProviderSkill>)),
    ),
  );

const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface CopilotInvocableSkill {
  readonly name: string;
  readonly commandName?: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
}

export interface CopilotSkillDispatch {
  readonly commandName: string;
  readonly input: string | undefined;
}

/**
 * Resolve the last invocable `$skill` mention to Copilot's native slash
 * command. The surrounding text becomes the skill input in its original order.
 */
export function planCopilotSkillDispatch(
  prompt: string,
  skills: ReadonlyArray<CopilotInvocableSkill>,
): CopilotSkillDispatch | undefined {
  const commandNames = new Map(
    skills
      .filter((skill) => skill.enabled && skill.userInvocable)
      .map((skill) => [skill.commandName?.trim() || skill.name.trim(), skill] as const)
      .filter(([commandName]) => commandName.length > 0),
  );
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const commandName = match[2] ?? "";
    if (!commandNames.has(commandName)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ commandName, start, end: start + commandName.length + 1 }];
  });
  const last = mentions.at(-1);
  if (!last) return undefined;

  const leading = prompt.slice(0, last.start).trimEnd();
  const trailing = prompt.slice(last.end).trimStart();
  const input = [leading, trailing].filter(Boolean).join("\n");
  return {
    commandName: last.commandName,
    input: input || undefined,
  };
}

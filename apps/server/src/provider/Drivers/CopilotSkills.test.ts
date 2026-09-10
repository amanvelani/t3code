import { describe, expect, it } from "vite-plus/test";

import { copilotSdkSkillsToServerProviderSkills } from "./CopilotSkills.ts";

describe("copilotSdkSkillsToServerProviderSkills", () => {
  it("maps native skill metadata and preserves the invocable command name", () => {
    expect(
      copilotSdkSkillsToServerProviderSkills([
        {
          name: "brainstorm",
          commandName: "superpowers:brainstorm",
          description: "Explore the problem first.",
          source: "plugin",
          userInvocable: true,
          enabled: true,
          path: "/Users/test/.copilot/plugins/superpowers/commands/brainstorm.md",
        },
        {
          name: "review",
          commandName: "review",
          description: "Review this workspace.",
          source: "inherited",
          userInvocable: false,
          enabled: false,
          path: "/workspace/.agents/skills/review/SKILL.md",
          projectPath: "/workspace",
        },
      ]),
    ).toEqual([
      {
        name: "superpowers:brainstorm",
        displayName: "brainstorm",
        description: "Explore the problem first.",
        path: "/Users/test/.copilot/plugins/superpowers/commands/brainstorm.md",
        scope: "plugin",
        enabled: true,
        userInvocable: true,
      },
      {
        name: "review",
        description: "Review this workspace.",
        path: "/workspace/.agents/skills/review/SKILL.md",
        scope: "project",
        enabled: false,
        userInvocable: false,
      },
    ]);
  });

  it("normalizes personal and builtin sources and skips entries without a path", () => {
    expect(
      copilotSdkSkillsToServerProviderSkills([
        {
          name: "personal-skill",
          description: "Personal.",
          source: "personal-copilot",
          userInvocable: true,
          enabled: true,
          path: "/Users/test/.copilot/skills/personal-skill/SKILL.md",
        },
        {
          name: "builtin-skill",
          description: "Builtin.",
          source: "builtin",
          userInvocable: true,
          enabled: true,
          path: "/opt/copilot/builtin/builtin-skill/SKILL.md",
        },
        {
          name: "custom-skill",
          description: "No local file.",
          source: "custom",
          userInvocable: true,
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        name: "personal-skill",
        description: "Personal.",
        path: "/Users/test/.copilot/skills/personal-skill/SKILL.md",
        scope: "personal",
        enabled: true,
        userInvocable: true,
      },
      {
        name: "builtin-skill",
        description: "Builtin.",
        path: "/opt/copilot/builtin/builtin-skill/SKILL.md",
        scope: "system",
        enabled: true,
        userInvocable: true,
      },
    ]);
  });
});

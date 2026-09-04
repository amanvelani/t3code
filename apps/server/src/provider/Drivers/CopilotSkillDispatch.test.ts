import { describe, expect, it } from "vite-plus/test";

import { planCopilotSkillDispatch } from "./CopilotSkillDispatch.ts";

const skills = [
  {
    name: "brainstorm",
    commandName: "superpowers:brainstorm",
    enabled: true,
    userInvocable: true,
  },
  { name: "review", commandName: "review", enabled: true, userInvocable: true },
  { name: "disabled", commandName: "disabled", enabled: false, userInvocable: true },
  { name: "agent-only", commandName: "agent-only", enabled: true, userInvocable: false },
];

describe("planCopilotSkillDispatch", () => {
  it("uses the native command name and keeps surrounding text as input", () => {
    expect(
      planCopilotSkillDispatch("Inspect this, $superpowers:brainstorm then propose a fix.", skills),
    ).toEqual({
      commandName: "superpowers:brainstorm",
      input: "Inspect this,\nthen propose a fix.",
    });
  });

  it("dispatches the last known skill and leaves earlier mentions in its input", () => {
    expect(planCopilotSkillDispatch("$review first, then $superpowers:brainstorm", skills)).toEqual(
      {
        commandName: "superpowers:brainstorm",
        input: "$review first, then",
      },
    );
  });

  it("ignores disabled, agent-only, and unknown mentions", () => {
    expect(planCopilotSkillDispatch("$disabled $agent-only $unknown", skills)).toBeUndefined();
  });
});

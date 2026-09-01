import { describe, expect, it } from "@effect/vitest";

import {
  hasDeployChanges,
  missingRelayPublicConfigFields,
  publicConfigFromOutput,
  reconcileRootEnvPublicConfig,
  RelayDeployError,
  serializeGithubOutput,
} from "./deploy.ts";

describe("RelayDeployError", () => {
  it("reports the incomplete state source, stage, and missing fields", () => {
    const missingFields = missingRelayPublicConfigFields({});
    const error = new RelayDeployError({
      source: "alchemy_state",
      stage: "production",
      missingFields,
    });

    expect(error).toMatchObject({
      source: "alchemy_state",
      stage: "production",
      missingFields: ["url"],
    });
    expect(error.message).toBe(
      "Relay deploy output from 'alchemy_state' for stage 'production' is missing required public config fields: url",
    );
  });
});

describe("hasDeployChanges", () => {
  it("detects resource, binding, and deletion changes", () => {
    expect(hasDeployChanges({ resources: {}, deletions: {} } as never)).toBe(false);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "create", bindings: [] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "noop", bindings: [{ action: "update" }] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {},
        deletions: {
          api: { action: "delete", bindings: [] },
        },
      } as never),
    ).toBe(true);
  });
});

describe("reconcileRootEnvPublicConfig", () => {
  const config = {
    relayUrl: "https://relay.example.test",
  } as const;

  it("adds the relay URL", () => {
    expect(reconcileRootEnvPublicConfig("", config)).toBe(
      ["T3CODE_RELAY_URL=https://relay.example.test", ""].join("\n"),
    );
  });

  it("replaces stale values while preserving unrelated entries", () => {
    expect(
      reconcileRootEnvPublicConfig(
        [
          "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example",
          "T3CODE_RELAY_URL=https://old.example.test",
          "",
        ].join("\n"),
        config,
      ),
    ).toBe(
      [
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example",
        "T3CODE_RELAY_URL=https://relay.example.test",
        "",
      ].join("\n"),
    );
  });
});

describe("serializeGithubOutput", () => {
  it("serializes relay deploy metadata for GitHub Actions outputs", () => {
    expect(
      serializeGithubOutput({
        changed: false,
        result: "noop",
        relay_url: "https://relay.example.test",
      }),
    ).toBe("changed=false\nresult=noop\nrelay_url=https://relay.example.test\n");
  });
});

describe("publicConfigFromOutput", () => {
  it("reads the relay URL from persisted Alchemy output", () => {
    expect(
      publicConfigFromOutput({
        url: "https://relay.example.test",
      }),
    ).toEqual({
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects incomplete stack output", () => {
    expect(publicConfigFromOutput({})).toBeNull();
  });
});

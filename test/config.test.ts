import { describe, expect, test } from "bun:test";
import { configFromEnv, DEFAULT_ACP_MODEL } from "../src/config.js";

describe("ACP agent defaults", () => {
  test("defaults new local agents to letta/auto without global pinning", () => {
    const config = configFromEnv({});

    expect(config.agentId).toBeUndefined();
    expect(config.model).toBe(DEFAULT_ACP_MODEL);
    expect(config.clientOptions).toEqual({
      backend: "local",
      appServer: { pinGlobalAgent: false },
    });
  });

  test("preserves explicit agent and model overrides", () => {
    const config = configFromEnv({
      LETTA_AGENT_ID: "agent-existing",
      LETTA_ACP_MODEL: "anthropic/claude-sonnet-4",
    });

    expect(config.agentId).toBe("agent-existing");
    expect(config.model).toBe("anthropic/claude-sonnet-4");
  });

  test("disables global pinning for remote and cloud-oauth app servers", () => {
    expect(
      configFromEnv({ LETTA_ACP_BACKEND: "remote" }).clientOptions,
    ).toMatchObject({
      backend: "remote",
      pinGlobalAgent: false,
    });
    expect(
      configFromEnv({ LETTA_ACP_BACKEND: "cloud-oauth" }).clientOptions,
    ).toEqual({
      backend: "local",
      appServer: {
        harnessBackend: "api",
        pinGlobalAgent: false,
      },
    });
  });
});

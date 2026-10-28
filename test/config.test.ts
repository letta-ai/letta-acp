import { describe, expect, test } from "bun:test";
import {
  configFromEnv,
  DEFAULT_ACP_MODEL,
  DEFAULT_IDLE_EVICT_MS,
} from "../src/config.js";

describe("ACP agent defaults", () => {
  test("keeps the session model unset and disables global pinning by default", () => {
    const config = configFromEnv({});

    expect(config.agentId).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(DEFAULT_ACP_MODEL).toBe("letta/auto");
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

describe("idle session eviction window", () => {
  test("defaults to ten minutes", () => {
    expect(DEFAULT_IDLE_EVICT_MS).toBe(600_000);
    expect(configFromEnv({}).idleEvictMs).toBe(DEFAULT_IDLE_EVICT_MS);
  });

  test("accepts an explicit window in seconds", () => {
    expect(
      configFromEnv({ LETTA_ACP_IDLE_EVICT_S: "90" }).idleEvictMs,
    ).toBe(90_000);
    expect(
      configFromEnv({ LETTA_ACP_IDLE_EVICT_S: "1.5" }).idleEvictMs,
    ).toBe(1_500);
  });

  test("treats an explicit 0 as disabled", () => {
    expect(configFromEnv({ LETTA_ACP_IDLE_EVICT_S: "0" }).idleEvictMs).toBe(0);
  });

  test("keeps the default for blank or unusable values", () => {
    // A typo must not silently disable eviction and reintroduce the leak, and
    // must not produce a window that evicts sessions immediately.
    for (const raw of ["", "   ", "soon", "-30", "NaN", "Infinity"]) {
      expect(configFromEnv({ LETTA_ACP_IDLE_EVICT_S: raw }).idleEvictMs).toBe(
        DEFAULT_IDLE_EVICT_MS,
      );
    }
  });
});

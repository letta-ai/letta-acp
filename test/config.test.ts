import { describe, expect, test } from "bun:test";
import { configFromEnv } from "../src/config.js";

/**
 * `configFromEnv` reads `process.env` by default; every case here passes an
 * explicit environment so the developer's own Letta credentials cannot decide
 * the result.
 */
describe("backend inference", () => {
  test("an API key alone selects cloud", () => {
    const config = configFromEnv({ LETTA_API_KEY: "sk-let-test" });
    expect(config.clientOptions).toEqual({
      backend: "cloud",
      apiKey: "sk-let-test",
    });
  });

  test("an empty environment stays local", () => {
    expect(configFromEnv({}).clientOptions).toEqual({ backend: "local" });
  });

  test("an app-server URL selects remote and is used verbatim", () => {
    const config = configFromEnv({
      LETTA_APP_SERVER_URL: "ws://box:4500",
      LETTA_APP_SERVER_TOKEN: "tok",
    });
    expect(config.clientOptions).toEqual({
      backend: "remote",
      url: "ws://box:4500",
      authToken: "tok",
    });
  });

  test("an app-server URL wins over an API key", () => {
    // A URL names one specific server; an API key is often exported for
    // unrelated tooling, so it must not silently redirect to Letta Cloud.
    const config = configFromEnv({
      LETTA_APP_SERVER_URL: "ws://box:4500",
      LETTA_API_KEY: "sk-let-test",
    });
    expect(config.clientOptions).toMatchObject({ backend: "remote" });
  });

  test("a blank URL does not select remote", () => {
    expect(
      configFromEnv({ LETTA_APP_SERVER_URL: "  ", LETTA_API_KEY: "sk-let-test" })
        .clientOptions,
    ).toMatchObject({ backend: "cloud" });
    expect(
      configFromEnv({ LETTA_APP_SERVER_URL: "" }).clientOptions,
    ).toEqual({ backend: "local" });
  });

  test("an explicit backend overrides inference", () => {
    // Reaching Letta Cloud through `letta login` rather than a key.
    const config = configFromEnv({
      LETTA_ACP_BACKEND: "cloud-oauth",
      LETTA_API_KEY: "sk-let-test",
      LETTA_APP_SERVER_URL: "ws://box:4500",
    });
    expect(config.clientOptions).toMatchObject({ backend: "local" });
    expect(config.sessionRegistryScope).toBe("cloud");
  });

  test("an explicit cloud backend still requires a key", () => {
    expect(() => configFromEnv({ LETTA_ACP_BACKEND: "cloud" })).toThrow(
      /requires LETTA_API_KEY/,
    );
  });

  test("an unknown backend is rejected", () => {
    expect(() => configFromEnv({ LETTA_ACP_BACKEND: "nope" })).toThrow(
      /Unknown LETTA_ACP_BACKEND/,
    );
  });
});

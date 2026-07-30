import { describe, expect, test } from "bun:test";
import { configFromEnv } from "../src/config.js";

/**
 * `configFromEnv` reads `process.env` by default; every case here passes an
 * explicit environment so the developer's own Letta credentials cannot decide
 * the result.
 */
describe("backend inference", () => {
  test("an API key alone selects cloud storage with local execution", () => {
    // `cloud-oauth` is a local app-server pointed at Letta Cloud: the agent
    // lives in the cloud, tools run on this machine. Plain `cloud` would move
    // execution into Letta's sandbox, away from the ACP client's files.
    const config = configFromEnv({ LETTA_API_KEY: "sk-let-test" });
    expect(config.clientOptions).toEqual({
      backend: "local",
      appServer: { harnessBackend: "api" },
    });
    expect(config.sessionRegistryScope).toBe("cloud");
  });

  test("an explicit cloud backend also executes locally", () => {
    // The SDK's sandboxed cloud mode is deliberately not reachable: an ACP
    // client's cwd, files, and terminals exist only on this machine.
    const config = configFromEnv({
      LETTA_ACP_BACKEND: "cloud",
      LETTA_API_KEY: "sk-let-test",
    });
    expect(config.clientOptions).toEqual({
      backend: "local",
      appServer: { harnessBackend: "api" },
    });
    expect(config.sessionRegistryScope).toBe("cloud");
  });

  test("cloud and cloud-oauth are the same backend", () => {
    expect(configFromEnv({ LETTA_ACP_BACKEND: "cloud" })).toEqual(
      configFromEnv({ LETTA_ACP_BACKEND: "cloud-oauth" }),
    );
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
    // Falls through to the key, i.e. cloud storage with local execution.
    expect(
      configFromEnv({ LETTA_APP_SERVER_URL: "  ", LETTA_API_KEY: "sk-let-test" })
        .sessionRegistryScope,
    ).toBe("cloud");
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

  test("cloud works without a key, via letta login", () => {
    // Credentials resolve like the CLI's: keychain token or LETTA_API_KEY.
    expect(() => configFromEnv({ LETTA_ACP_BACKEND: "cloud" })).not.toThrow();
  });

  test("an unknown backend is rejected", () => {
    expect(() => configFromEnv({ LETTA_ACP_BACKEND: "nope" })).toThrow(
      /Unknown LETTA_ACP_BACKEND/,
    );
  });
});

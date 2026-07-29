import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/session-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "letta-acp-sessions-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SessionRegistry", () => {
  test("persists project-scoped sessions across adapter processes", async () => {
    const directory = await temporaryDirectory();
    const first = new SessionRegistry(directory, "cloud");
    await first.record("agent-1", "conv-one", "/workspace/one");
    await first.record("agent-1", "conv-two", "/workspace/two");
    await first.record("agent-2", "conv-other-agent", "/workspace/one");

    const restarted = new SessionRegistry(directory, "cloud");
    expect(await restarted.list("agent-1", "/workspace/one")).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "conv-one",
        cwd: "/workspace/one",
      }),
    ]);
  });

  test("isolates records from different backends", async () => {
    const directory = await temporaryDirectory();
    await new SessionRegistry(directory, "cloud").record(
      "agent-1",
      "conv-cloud",
      "/workspace",
    );

    expect(
      await new SessionRegistry(directory, "local").list("agent-1", "/workspace"),
    ).toEqual([]);
  });

  test("observes records removed by another adapter process", async () => {
    const directory = await temporaryDirectory();
    const first = new SessionRegistry(directory, "cloud");
    const second = new SessionRegistry(directory, "cloud");
    await first.record("agent-1", "conv-one", "/workspace");
    expect(await second.list("agent-1", "/workspace")).toHaveLength(1);

    await first.remove("conv-one");

    expect(await second.list("agent-1", "/workspace")).toEqual([]);
  });

  test("moves a conversation when it is loaded from a different cwd", async () => {
    const directory = await temporaryDirectory();
    const registry = new SessionRegistry(directory, "cloud");
    await registry.record("agent-1", "conv-one", "/workspace/one");
    await registry.record("agent-1", "conv-one", "/workspace/two");

    expect(await registry.list("agent-1", "/workspace/one")).toEqual([]);
    expect(await registry.list("agent-1", "/workspace/two")).toHaveLength(1);
  });

  test("rejects relative working directories", async () => {
    const registry = new SessionRegistry(null, "test");
    await expect(registry.record("agent-1", "conv-one", "relative/path")).rejects.toThrow(
      "cwd must be absolute",
    );
  });
});

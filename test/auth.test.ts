import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authMethodsForClient,
  runTerminalLogin,
} from "../src/auth.js";

describe("ACP terminal authentication", () => {
  test("advertises Letta login to clients with terminal auth support", () => {
    expect(
      authMethodsForClient({ auth: { terminal: true } }, true),
    ).toEqual([
      {
        id: "letta-login",
        name: "Log in to Letta",
        description: "Authenticate with Letta in an interactive terminal",
        type: "terminal",
        args: ["--login"],
      },
    ]);
  });

  test("supports the registry validator's legacy terminal capability", () => {
    expect(
      authMethodsForClient({ _meta: { "terminal-auth": true } }, true),
    ).toHaveLength(1);
  });

  test("does not advertise a terminal flow the client cannot launch", () => {
    expect(authMethodsForClient({}, true)).toEqual([]);
  });

  test("does not advertise Letta login for explicit-key or remote backends", () => {
    expect(
      authMethodsForClient({ auth: { terminal: true } }, false),
    ).toEqual([]);
  });

  test("delegates --login to the bundled Letta CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "letta-acp-auth-"));
    const script = join(directory, "fake-letta.js");
    const output = join(directory, "args.json");
    await writeFile(
      script,
      `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`,
    );
    try {
      expect(await runTerminalLogin(script)).toBe(0);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(["login"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

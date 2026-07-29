import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editorReadAutoAllows,
  modeAutoAllows,
  permissionModeConfigOption,
} from "../src/session-modes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const BOOKKEEPING_TOOLS = [
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
];

describe("session mode tool approvals", () => {
  test("publishes permissions as a modern ACP mode config option", () => {
    expect(permissionModeConfigOption("unrestricted")).toEqual({
      id: "permissions",
      name: "Permissions",
      description: "Approval behavior for tool calls",
      category: "mode",
      type: "select",
      currentValue: "unrestricted",
      options: [
        {
          value: "standard",
          name: "Ask before edits",
          description:
            "Allow workspace reads; ask before edits, shell commands, and outside-workspace reads",
        },
        {
          value: "acceptEdits",
          name: "Accept edits",
          description:
            "Allow workspace reads and file edits; ask before shell commands and outside-workspace reads",
        },
        {
          value: "unrestricted",
          name: "Bypass permissions",
          description: "Auto-allow all tool calls without asking",
        },
      ],
    });
  });

  test.each(BOOKKEEPING_TOOLS)(
    "auto-allows %s in ask-before-edits mode",
    (toolName) => {
      expect(modeAutoAllows("standard", toolName)).toBe(true);
    },
  );

  test("still asks before workspace mutations and commands", () => {
    expect(modeAutoAllows("standard", "Edit")).toBe(false);
    expect(modeAutoAllows("standard", "Write")).toBe(false);
    expect(modeAutoAllows("standard", "Bash")).toBe(false);
  });

  test("keeps accept-edits and unrestricted behavior", () => {
    expect(modeAutoAllows("acceptEdits", "Edit")).toBe(true);
    expect(modeAutoAllows("acceptEdits", "write_via_editor")).toBe(true);
    expect(modeAutoAllows("acceptEdits", "Bash")).toBe(false);
    expect(modeAutoAllows("unrestricted", "Bash")).toBe(true);
  });
});

describe("editor read workspace boundary", () => {
  test("auto-allows canonical files inside the session cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-acp-mode-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repo");
    const source = join(workspace, "src", "index.ts");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(source, "export {};\n");

    for (const mode of ["standard", "acceptEdits"] as const) {
      for (const path of [source, join(workspace, "src", "unsaved.ts")]) {
        expect(
          await editorReadAutoAllows(
            mode,
            "read_editor_buffer",
            { path },
            workspace,
          ),
        ).toBe(true);
      }
    }
  });

  test("keeps outside, sibling-prefix, and symlink escapes controlled", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-acp-mode-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repo");
    const sibling = join(root, "repo-private");
    const outside = join(sibling, "secret.ts");
    await mkdir(workspace, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(outside, "secret\n");
    await symlink(outside, join(workspace, "linked-secret.ts"));
    await symlink(sibling, join(workspace, "linked-directory"));
    await symlink(
      join(sibling, "missing-target.ts"),
      join(workspace, "dangling-secret.ts"),
    );

    for (const mode of ["standard", "acceptEdits"] as const) {
      for (const path of [
        outside,
        join(workspace, "..", "repo-private", "secret.ts"),
        join(workspace, "linked-secret.ts"),
        join(workspace, "linked-directory", "missing.ts"),
        join(workspace, "dangling-secret.ts"),
      ]) {
        expect(
          await editorReadAutoAllows(
            mode,
            "read_editor_buffer",
            { path },
            workspace,
          ),
        ).toBe(false);
      }
    }
  });

  test("does not affect other tools and unrestricted remains unrestricted", async () => {
    expect(
      await editorReadAutoAllows(
        "standard",
        "write_via_editor",
        { path: "/outside/file.ts" },
        "/workspace",
      ),
    ).toBe(false);
    expect(
      await editorReadAutoAllows(
        "unrestricted",
        "read_editor_buffer",
        { path: "/outside/file.ts" },
        "/workspace",
      ),
    ).toBe(true);
  });
});

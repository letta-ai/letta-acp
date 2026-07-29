import { describe, expect, test } from "bun:test";
import {
  modeAutoAllows,
  permissionModeConfigOption,
} from "../src/session-modes.js";

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
          description: "Request permission for file edits and shell commands",
        },
        {
          value: "acceptEdits",
          name: "Accept edits",
          description: "Auto-allow file edits; still ask for shell commands",
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
    expect(modeAutoAllows("acceptEdits", "Bash")).toBe(false);
    expect(modeAutoAllows("unrestricted", "Bash")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { modeAutoAllows } from "../src/session-modes.js";

const BOOKKEEPING_TOOLS = [
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
];

describe("session mode tool approvals", () => {
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

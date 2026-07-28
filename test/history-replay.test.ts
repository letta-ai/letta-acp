import { describe, expect, test } from "bun:test";
import { historyToUpdates } from "../src/history-replay.js";

describe("tool history replay", () => {
  test("replays a completed Edit as a native diff instead of result JSON", () => {
    const updates = historyToUpdates([
      {
        message_type: "tool_call_message",
        tool_calls: [
          {
            tool_call_id: "call-edit",
            name: "Edit",
            arguments: JSON.stringify({
              file_path: "/tmp/example.ts",
              old_string: "const value = 1;",
              new_string: "const value = 2;",
            }),
          },
        ],
      },
      {
        message_type: "tool_return_message",
        tool_call_id: "call-edit",
        status: "success",
        tool_return:
          '{"message":"Successfully replaced 1 occurrence","replacements":1,"startLine":12}',
      },
    ]);

    expect(updates[0]).toEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "call-edit",
        content: [
          {
            type: "diff",
            path: "/tmp/example.ts",
            oldText: "const value = 1;",
            newText: "const value = 2;",
          },
        ],
        locations: [{ path: "/tmp/example.ts" }],
      }),
    );
    expect(updates[1]).toEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-edit",
        status: "completed",
        rawOutput: {
          message: "Successfully replaced 1 occurrence",
          replacements: 1,
          startLine: 12,
        },
        locations: [{ path: "/tmp/example.ts", line: 12 }],
      }),
    );
    expect(updates[1]).not.toHaveProperty("content");
  });

  test("preserves text output for non-edit tools", () => {
    const updates = historyToUpdates([
      {
        message_type: "tool_call_message",
        tool_calls: [
          {
            tool_call_id: "call-bash",
            name: "Bash",
            arguments: JSON.stringify({ command: "pwd" }),
          },
        ],
      },
      {
        message_type: "tool_return_message",
        tool_call_id: "call-bash",
        status: "success",
        tool_return: "/tmp/project",
      },
    ]);

    expect(updates[1]).toEqual(
      expect.objectContaining({
        status: "completed",
        rawOutput: "/tmp/project",
        content: [
          {
            type: "content",
            content: { type: "text", text: "/tmp/project" },
          },
        ],
      }),
    );
  });
});

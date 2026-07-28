import { describe, expect, test } from "bun:test";
import {
  accumulateToolInput,
  parseToolOutput,
  toolDiffContent,
  toolLocations,
  toolOutputLine,
  toolTitle,
} from "../src/tool-info.js";

describe("fragmented tool arguments", () => {
  test("builds the display title after the final argument fragment", () => {
    const first = accumulateToolInput(
      undefined,
      '{"command":"git status","descr',
      { raw: '{"command":"git status","descr' },
    );
    expect(toolTitle("Bash", first.input)).toBe("Bash");

    const complete = accumulateToolInput(
      first,
      'iption":"Show working tree status"}',
      { raw: 'iption":"Show working tree status"}' },
    );
    expect(complete.input).toEqual({
      command: "git status",
      description: "Show working tree status",
    });
    expect(toolTitle("Bash", complete.input)).toBe(
      "Bash: Show working tree status",
    );
    expect(complete.complete).toBe(true);
  });

  test("reports everything received while arguments are still partial", () => {
    const first = accumulateToolInput(undefined, '{"command":"git log"', {
      raw: '{"command":"git log"',
    });
    const second = accumulateToolInput(first, ',"description":"Show the ', {
      raw: ',"description":"Show the ',
    });

    expect(second.complete).toBe(false);
    // Not just the trailing fragment, which would drop what the client was
    // already shown.
    expect(second.input).toEqual({
      raw: '{"command":"git log","description":"Show the ',
    });
  });

  test("treats a self-contained fragment as a re-emission, not a continuation", () => {
    // The SDK reports streamed deltas and assembled messages through the same
    // shape, so the whole argument string can arrive twice. Appending would
    // leave `{...}{...}` in the buffer, which never parses again.
    const args = { command: "pwd", description: "Print working directory" };
    const raw = JSON.stringify(args);
    const first = accumulateToolInput(undefined, raw, args);
    const repeated = accumulateToolInput(first, raw, args);

    expect(repeated.rawArguments).toBe(raw);
    expect(repeated.input).toEqual(args);
    expect(repeated.complete).toBe(true);

    const afterPartial = accumulateToolInput(
      { rawArguments: '{"command":', input: {}, complete: false },
      raw,
      args,
    );
    expect(afterPartial.input).toEqual(args);
  });

  test("keeps arguments that are not JSON at all", () => {
    const state = accumulateToolInput(undefined, "not json", {
      raw: "not json",
    });
    expect(state.complete).toBe(false);
    expect(state.input).toEqual({ raw: "not json" });
  });

  test("preserves complete input when the SDK emits one message", () => {
    const input = { file_path: "/tmp/example.ts" };
    const complete = accumulateToolInput(
      undefined,
      JSON.stringify(input),
      input,
    );
    expect(complete.input).toEqual(input);
    expect(toolLocations(complete.input)).toEqual([{ path: "/tmp/example.ts" }]);
  });
});

describe("edit tool presentation", () => {
  test("maps a complete Edit input to a native ACP diff", () => {
    expect(
      toolDiffContent("Edit", {
        file_path: "/tmp/example.ts",
        old_string: "const value = 1;",
        new_string: "const value = 2;",
      }),
    ).toEqual([
      {
        type: "diff",
        path: "/tmp/example.ts",
        oldText: "const value = 1;",
        newText: "const value = 2;",
      },
    ]);
  });

  test("waits for all Edit arguments before rendering a diff", () => {
    expect(
      toolDiffContent("Edit", {
        file_path: "/tmp/example.ts",
        old_string: "const value = 1;",
      }),
    ).toEqual([]);
  });

  test("maps Write and editor-backed writes to creation diffs", () => {
    const input = { file_path: "/tmp/new.ts", content: "export {};" };
    const expected = [
      {
        type: "diff" as const,
        path: "/tmp/new.ts",
        oldText: null,
        newText: "export {};",
      },
    ];
    expect(toolDiffContent("Write", input)).toEqual(expected);
    expect(
      toolDiffContent("write_via_editor", {
        path: "/tmp/new.ts",
        content: "export {};",
      }),
    ).toEqual(expected);
  });

  test("maps each complete MultiEdit replacement to a diff", () => {
    expect(
      toolDiffContent("MultiEdit", {
        file_path: "/tmp/example.ts",
        edits: [
          { old_string: "one", new_string: "ONE" },
          { old_string: "two", new_string: "TWO" },
        ],
      }),
    ).toEqual([
      {
        type: "diff",
        path: "/tmp/example.ts",
        oldText: "one",
        newText: "ONE",
      },
      {
        type: "diff",
        path: "/tmp/example.ts",
        oldText: "two",
        newText: "TWO",
      },
    ]);
  });

  test("extracts structured output and the first changed line", () => {
    const output = parseToolOutput(
      '{"message":"Updated file","replacements":1,"startLine":12}',
    );
    expect(output).toEqual({
      message: "Updated file",
      replacements: 1,
      startLine: 12,
    });
    expect(toolOutputLine(output)).toBe(12);
    expect(toolLocations({ file_path: "/tmp/example.ts" }, 12)).toEqual([
      { path: "/tmp/example.ts", line: 12 },
    ]);
    expect(toolLocations({ file_path: "C:\\repo\\example.ts" }, 12)).toEqual([
      { path: "C:\\repo\\example.ts", line: 12 },
    ]);
  });
});

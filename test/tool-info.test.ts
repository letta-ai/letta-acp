import { describe, expect, test } from "bun:test";
import { accumulateToolInput, toolLocations, toolTitle } from "../src/tool-info.js";

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

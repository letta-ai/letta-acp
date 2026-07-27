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

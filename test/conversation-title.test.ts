import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  titleFromFirstMessage,
} from "../src/conversation-title.js";

describe("titleFromFirstMessage", () => {
  test("collapses whitespace", () => {
    expect(titleFromFirstMessage("fix the\n  flaky   auth test")).toBe(
      "fix the flaky auth test",
    );
  });

  test("drops one layer of surrounding quotes", () => {
    expect(titleFromFirstMessage('"add pagination"')).toBe("add pagination");
    expect(titleFromFirstMessage("'rename Session'")).toBe("rename Session");
  });

  test("returns null for blank input", () => {
    expect(titleFromFirstMessage("   \n  ")).toBeNull();
    expect(titleFromFirstMessage('""')).toBeNull();
  });

  test("clamps to the max length", () => {
    const title = titleFromFirstMessage("x".repeat(CONVERSATION_TITLE_MAX_LENGTH + 40));
    expect(title).toHaveLength(CONVERSATION_TITLE_MAX_LENGTH);
  });
});

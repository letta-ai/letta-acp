import { describe, expect, test } from "bun:test";
import type { ListModelsResult } from "@letta-ai/letta-agent-sdk";
import { buildModelOption, withCurrentValue } from "../src/model-options.js";

function entry(
  handle: string,
  label: string,
  extra: Partial<ListModelsResult["entries"][number]> = {},
): ListModelsResult["entries"][number] {
  return {
    id: handle.split("/").pop() ?? handle,
    handle,
    label,
    description: "",
    ...extra,
  };
}

function values(option: ReturnType<typeof buildModelOption>): string[] {
  if (!option || option.type !== "select") return [];
  return option.options.map((item) => ("value" in item ? item.value : ""));
}

describe("model config option", () => {
  test("collapses the reasoning tiers that share one handle", () => {
    const option = buildModelOption({
      entries: [
        entry("anthropic/claude-fable-5", "Fable 5 (low)"),
        entry("anthropic/claude-fable-5", "Fable 5", { isDefault: true }),
        entry("openai/gpt-4.1", "GPT-4.1"),
      ],
    });

    expect(values(option)).toEqual([
      "anthropic/claude-fable-5",
      "openai/gpt-4.1",
    ]);
    // The default tier is the one kept, whichever order it arrived in.
    expect(
      option?.type === "select" ? option.options[0]?.name : null,
    ).toBe("Fable 5");
  });

  test("offers only the handles this user can reach", () => {
    const option = buildModelOption({
      entries: [entry("a/one", "One"), entry("b/two", "Two")],
      availableHandles: ["b/two"],
    });

    expect(values(option)).toEqual(["b/two"]);
    expect(option?.type === "select" ? option.currentValue : null).toBe("b/two");
  });

  test("offers the whole catalog when availability lookup failed", () => {
    const option = buildModelOption({
      entries: [entry("a/one", "One"), entry("b/two", "Two")],
      availableHandles: null,
    });

    expect(values(option)).toEqual(["a/one", "b/two"]);
  });

  test("preselects a configured model, by handle or by id", () => {
    const entries = [
      entry("a/one", "One", { isDefault: true }),
      entry("b/two", "Two"),
    ];

    expect(
      buildModelOption({ entries }, "b/two")?.type === "select"
        ? buildModelOption({ entries }, "b/two")?.currentValue
        : null,
    ).toBe("b/two");
    const byId = buildModelOption({ entries }, "two");
    expect(byId?.type === "select" ? byId.currentValue : null).toBe("b/two");
  });

  test("falls back to the catalog default, then to the first entry", () => {
    const withDefault = buildModelOption({
      entries: [entry("a/one", "One"), entry("b/two", "Two", { isDefault: true })],
    });
    expect(withDefault?.type === "select" ? withDefault.currentValue : null).toBe(
      "b/two",
    );

    const noDefault = buildModelOption({
      entries: [entry("a/one", "One"), entry("b/two", "Two")],
    });
    expect(noDefault?.type === "select" ? noDefault.currentValue : null).toBe(
      "a/one",
    );
  });

  test("publishes nothing when no model is reachable", () => {
    expect(buildModelOption({ entries: [] })).toBeNull();
    expect(
      buildModelOption({
        entries: [entry("a/one", "One")],
        availableHandles: [],
      }),
    ).toBeNull();
  });

  test("withCurrentValue keeps the published option list", () => {
    const option = buildModelOption({
      entries: [entry("a/one", "One"), entry("b/two", "Two")],
    });
    const switched = withCurrentValue(option!, "b/two");

    expect(switched.type === "select" ? switched.currentValue : null).toBe(
      "b/two",
    );
    expect(values(switched)).toEqual(values(option));
  });
});

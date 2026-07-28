import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Grep: "search",
  Glob: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  TodoWrite: "think",
  Task: "other",
  Agent: "other",
};

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

export interface ToolCallInputState {
  rawArguments: string;
  input: Record<string, unknown>;
  /** True once `rawArguments` parsed into a JSON object. */
  complete: boolean;
}

/** Accumulate one SDK argument fragment and parse it once complete. */
export function accumulateToolInput(
  previous: ToolCallInputState | undefined,
  fragment: string | undefined,
  parsedFragment: Record<string, unknown>,
): ToolCallInputState {
  const rawArguments = `${previous?.rawArguments ?? ""}${fragment ?? ""}`;
  const accumulated = parseArgumentObject(rawArguments);
  if (accumulated) {
    return { rawArguments, input: accumulated, complete: true };
  }

  // The SDK emits streamed deltas and assembled messages through the same
  // tool_call shape, so a fragment that parses on its own is a re-emission of
  // the whole argument string rather than a continuation. Replace the buffer:
  // appending would leave `{...}{...}`, which can never parse again.
  const whole = parseArgumentObject(fragment);
  if (whole) {
    return { rawArguments: fragment ?? "", input: whole, complete: true };
  }

  // Still partial. Report everything received so far rather than the trailing
  // fragment alone, matching how the SDK surfaces unparseable arguments.
  if (!rawArguments) {
    return { rawArguments, input: parsedFragment, complete: false };
  }
  return { rawArguments, input: { raw: rawArguments }, complete: false };
}

function parseArgumentObject(
  text: string | undefined,
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Incomplete JSON, or arguments that were never JSON to begin with.
  }
  return null;
}

/** Short human-readable title for a tool call, e.g. `Read src/index.ts`. */
export function toolTitle(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const detail =
    firstString(toolInput, [
      "file_path",
      "path",
      "notebook_path",
      "pattern",
      "url",
      "query",
      "description",
    ]) ?? firstString(toolInput, ["command"]);
  if (!detail) return toolName;
  const trimmed = detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
  return `${toolName}: ${trimmed}`;
}

/** File locations touched by a tool call, for editors that follow along. */
export function toolLocations(
  toolInput: Record<string, unknown>,
): ToolCallLocation[] {
  const path = firstString(toolInput, ["file_path", "notebook_path", "path"]);
  if (path?.startsWith("/")) {
    return [{ path }];
  }
  return [];
}

function firstString(
  input: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

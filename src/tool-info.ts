import type {
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { isAbsolute, win32 } from "node:path";

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
  read_editor_buffer: "read",
  write_via_editor: "edit",
};

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

export interface ToolCallInputState {
  rawArguments: string;
  input: Record<string, unknown>;
}

/** Accumulate one SDK argument fragment and parse it once complete. */
export function accumulateToolInput(
  previous: ToolCallInputState | undefined,
  fragment: string | undefined,
  parsedFragment: Record<string, unknown>,
): ToolCallInputState {
  const rawArguments = `${previous?.rawArguments ?? ""}${fragment ?? ""}`;
  if (rawArguments) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          rawArguments,
          input: parsed as Record<string, unknown>,
        };
      }
    } catch {
      // More fragments may still arrive.
    }
  }
  return { rawArguments, input: parsedFragment };
}

/** Native ACP diff content for file-edit tools once their input is complete. */
export function toolDiffContent(
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolCallContent[] {
  const normalizedName = toolName.toLowerCase();
  const path = firstString(toolInput, ["file_path", "path"]);
  if (!path) return [];

  if (normalizedName === "edit") {
    const oldText = toolInput.old_string;
    const newText = toolInput.new_string;
    if (typeof oldText !== "string" || typeof newText !== "string") return [];
    return [{ type: "diff", path, oldText: oldText || null, newText }];
  }

  if (normalizedName === "multiedit" || normalizedName === "multi_edit") {
    if (!Array.isArray(toolInput.edits)) return [];
    return toolInput.edits.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const edit = item as Record<string, unknown>;
      if (
        typeof edit.old_string !== "string" ||
        typeof edit.new_string !== "string"
      ) {
        return [];
      }
      return [
        {
          type: "diff" as const,
          path,
          oldText: edit.old_string || null,
          newText: edit.new_string,
        },
      ];
    });
  }

  if (normalizedName === "write" || normalizedName === "write_via_editor") {
    const newText = toolInput.content;
    if (typeof newText !== "string") return [];
    return [{ type: "diff", path, oldText: null, newText }];
  }

  return [];
}

/** Parse tool output for ACP rawOutput while preserving non-JSON text. */
export function parseToolOutput(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
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
  line?: number,
): ToolCallLocation[] {
  const path = firstString(toolInput, ["file_path", "notebook_path", "path"]);
  if (path && (isAbsolute(path) || win32.isAbsolute(path))) {
    return [{ path, ...(line !== undefined ? { line } : {}) }];
  }
  return [];
}

/** First changed line reported by Edit/Write tool results, when available. */
export function toolOutputLine(output: unknown): number | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const line = (output as Record<string, unknown>).startLine;
  return typeof line === "number" && Number.isInteger(line) && line >= 1
    ? line
    : undefined;
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

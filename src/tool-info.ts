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

const TOOL_OUTPUT_DISPLAY_BYTES = 16 * 1024;
const TOOL_OUTPUT_DISPLAY_LINES = 24;

export function isTerminalOutputTool(toolName: string): boolean {
  return toolName.toLowerCase() === "bash";
}

/**
 * Keep tool cards compact without changing the full rawOutput payload. Preserve
 * both ends because failures and summaries commonly land at the end of output.
 */
export function boundedToolOutput(content: string): string {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline) lines.pop();
  let display = content;
  if (lines.length > TOOL_OUTPUT_DISPLAY_LINES) {
    const side = TOOL_OUTPUT_DISPLAY_LINES / 2;
    const omitted = lines.length - TOOL_OUTPUT_DISPLAY_LINES;
    display = `${[
      ...lines.slice(0, side),
      `… ${omitted} lines omitted from display …`,
      ...lines.slice(-side),
    ].join("\n")}${trailingNewline ? "\n" : ""}`;
  }

  const encoded = Buffer.from(display);
  if (encoded.byteLength <= TOOL_OUTPUT_DISPLAY_BYTES) return display;

  const marker = "\n\n… output truncated for display …\n\n";
  const markerBytes = Buffer.byteLength(marker);
  const remaining = TOOL_OUTPUT_DISPLAY_BYTES - markerBytes;
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;
  return `${decodeUtf8Boundary(encoded.subarray(0, headBytes), "head")}${marker}${decodeUtf8Boundary(
    encoded.subarray(encoded.byteLength - tailBytes),
    "tail",
  )}`;
}

function decodeUtf8Boundary(bytes: Buffer, side: "head" | "tail"): string {
  for (let offset = 0; offset < Math.min(4, bytes.byteLength); offset += 1) {
    const candidate =
      side === "head" ? bytes.subarray(0, bytes.byteLength - offset) : bytes.subarray(offset);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    } catch {
      // The byte slice may start or end inside a multibyte codepoint.
    }
  }
  return "";
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
  if (isTerminalOutputTool(toolName)) {
    const command = firstString(toolInput, ["command"]);
    // Keep the executable command intact: shortening or replacing it with a
    // friendly description can hide the operation a user is approving.
    return command ?? toolName;
  }
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

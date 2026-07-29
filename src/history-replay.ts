import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  boundedToolOutput,
  isTerminalOutputTool,
  parseToolOutput,
  toolDiffContent,
  toolKind,
  toolLocations,
  toolOutputLine,
  toolTitle,
} from "./tool-info.js";

/**
 * Raw Letta API history messages (session.listMessages) -> ACP session/update
 * payloads for session/load replay. Tolerant of unknown shapes: anything we
 * can't map is skipped.
 */
export function historyToUpdates(
  messages: unknown[],
  options: { terminalOutput?: boolean; cwd?: string } = {},
): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  const toolInputs = new Map<string, Record<string, unknown>>();
  const toolNames = new Map<string, string>();
  const diffToolCalls = new Set<string>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const messageType = message.message_type;
    switch (messageType) {
      case "user_message": {
        const text = extractText(message.content);
        // Letta wraps system/heartbeat traffic as user messages (JSON bodies,
        // <system-reminder> blocks); only replay plain human text.
        if (
          text &&
          !looksLikeSystemJson(text) &&
          !text.trimStart().startsWith("<system-reminder>")
        ) {
          updates.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          });
        }
        break;
      }
      case "assistant_message": {
        const text = extractText(message.content);
        if (text) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        }
        break;
      }
      case "reasoning_message": {
        const text =
          typeof message.reasoning === "string"
            ? message.reasoning
            : extractText(message.content);
        if (text) {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text },
          });
        }
        break;
      }
      case "tool_call_message":
      case "approval_request_message": {
        const toolCall = firstToolCall(message);
        if (!toolCall) break;
        const toolCallId = readString(toolCall, ["tool_call_id", "id"]);
        if (!toolCallId) break;
        const toolName = readString(toolCall, ["name"]) ?? "tool";
        const input = parseArguments(toolCall.arguments);
        const diffContent = toolDiffContent(toolName, input);
        const nativeTerminal =
          options.terminalOutput === true && isTerminalOutputTool(toolName);
        toolInputs.set(toolCallId, input);
        toolNames.set(toolCallId, toolName);
        if (diffContent.length > 0) diffToolCalls.add(toolCallId);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(toolName, input),
          kind: toolKind(toolName),
          status: nativeTerminal ? "in_progress" : "completed",
          rawInput: input,
          locations: toolLocations(input),
          ...(diffContent.length > 0
            ? { content: diffContent }
            : nativeTerminal
              ? {
                  content: [{ type: "terminal", terminalId: toolCallId }],
                  _meta: {
                    terminal_info: {
                      terminal_id: toolCallId,
                      ...(options.cwd ? { cwd: options.cwd } : {}),
                    },
                  },
                }
              : {}),
        });
        break;
      }
      case "tool_return_message": {
        const toolCallId = readString(message, ["tool_call_id"]);
        if (!toolCallId) break;
        const text =
          extractText(message.tool_return) ?? extractText(message.content);
        const failed = message.status === "error";
        const rawOutput = text !== undefined ? parseToolOutput(text) : undefined;
        const input = toolInputs.get(toolCallId);
        const toolName = toolNames.get(toolCallId);
        const hasDiff = diffToolCalls.has(toolCallId);
        const nativeTerminal =
          options.terminalOutput === true &&
          toolName !== undefined &&
          isTerminalOutputTool(toolName);
        toolInputs.delete(toolCallId);
        toolNames.delete(toolCallId);
        diffToolCalls.delete(toolCallId);
        const locations = input
          ? toolLocations(input, toolOutputLine(rawOutput))
          : [];
        if (nativeTerminal && text !== undefined) {
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId,
            _meta: {
              terminal_output: { terminal_id: toolCallId, data: text },
            },
          });
        }
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: failed ? "failed" : "completed",
          ...(rawOutput !== undefined ? { rawOutput } : {}),
          ...(locations.length > 0 ? { locations } : {}),
          ...(nativeTerminal
            ? {
                _meta: {
                  terminal_exit: {
                    terminal_id: toolCallId,
                    exit_code: failed ? 1 : 0,
                    signal: null,
                  },
                },
              }
            : text && (!hasDiff || failed)
              ? {
                  content: [
                    {
                      type: "content",
                      content: {
                        type: "text",
                        text:
                          toolName && isTerminalOutputTool(toolName)
                            ? boundedToolOutput(text)
                            : text,
                      },
                    },
                  ],
                }
              : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return updates;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        parts.push((item as Record<string, unknown>).text as string);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}

function looksLikeSystemJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.type === "string";
  } catch {
    return false;
  }
}

function firstToolCall(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const single = message.tool_call;
  if (single && typeof single === "object") {
    return single as Record<string, unknown>;
  }
  const many = message.tool_calls;
  if (Array.isArray(many) && many[0] && typeof many[0] === "object") {
    return many[0] as Record<string, unknown>;
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

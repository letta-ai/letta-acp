import { type AgentContext, methods } from "@agentclientprotocol/sdk";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

/** Client fs capabilities negotiated during ACP initialize. */
export interface EditorFsCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

interface EditorToolContext {
  /** ACP session these tools are bound to (assigned once known). */
  getSessionId: () => string;
  /** Returns the in-flight prompt's ACP context, or null between turns. */
  getPromptContext: () => AgentContext | null;
}

/**
 * External tools that delegate file access to the ACP client (the editor).
 *
 * The Letta harness's built-in Read/Edit/Write always operate on disk. These
 * tools proxy ACP `fs/read_text_file` / `fs/write_text_file` instead, so the
 * agent can see unsaved editor buffers and route edits through the editor's
 * buffer (diff review, undo history). Registered per-session, and only for
 * capabilities the client advertised during initialize.
 */
export function createEditorTools(
  caps: EditorFsCapabilities,
  context: EditorToolContext,
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  if (caps.readTextFile) {
    tools.push({
      name: "read_editor_buffer",
      label: "Read editor buffer",
      description:
        "Read a text file through the user's editor, including unsaved changes " +
        "in open buffers. Prefer this over Read for files the user may have " +
        "open in their editor; use Read for everything else. Requires an " +
        "absolute path. Optionally pass line (1-based) and limit to read a slice.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file",
          },
          line: {
            type: "number",
            description: "1-based line number to start reading from",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, args) => {
        const { path, line, limit } = readFsArgs(args, { allowRange: true });
        const cx = requireContext(context);
        const response = await cx.request(methods.client.fs.readTextFile, {
          sessionId: context.getSessionId(),
          path,
          ...(line !== undefined ? { line } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return { content: [{ type: "text", text: response.content }] };
      },
    });
  }
  if (caps.writeTextFile) {
    tools.push({
      name: "write_via_editor",
      label: "Write via editor",
      description:
        "Write the full contents of a text file through the user's editor, so " +
        "the change lands in the editor's buffer with diff review and undo " +
        "history. Prefer this over Write/Edit for files the user may have open " +
        "in their editor; use the built-in tools for everything else. Requires " +
        "an absolute path and replaces the entire file content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file",
          },
          content: {
            type: "string",
            description: "Full new content of the file",
          },
        },
        required: ["path", "content"],
      },
      execute: async (_toolCallId, args) => {
        const { path } = readFsArgs(args, { allowRange: false });
        const record = args as Record<string, unknown>;
        const content = record.content;
        if (typeof content !== "string") {
          throw new Error("content must be a string");
        }
        const cx = requireContext(context);
        await cx.request(methods.client.fs.writeTextFile, {
          sessionId: context.getSessionId(),
          path,
          content,
        });
        return {
          content: [{ type: "text", text: `Wrote ${path} via the editor.` }],
        };
      },
    });
  }
  return tools;
}

function requireContext(context: EditorToolContext): AgentContext {
  const cx = context.getPromptContext();
  if (!cx) {
    throw new Error("No active ACP prompt; editor tools are unavailable");
  }
  return cx;
}

function readFsArgs(
  args: unknown,
  options: { allowRange: boolean },
): { path: string; line?: number; limit?: number } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Expected an arguments object");
  }
  const record = args as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("path must be an absolute path string");
  }
  if (!options.allowRange) {
    return { path };
  }
  const line = typeof record.line === "number" ? record.line : undefined;
  const limit = typeof record.limit === "number" ? record.limit : undefined;
  return { path, line, limit };
}

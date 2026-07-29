import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AgentToolResultContent,
  AnyAgentTool,
} from "@letta-ai/letta-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

/** MCP servers connected for one ACP session, plus the tools they expose. */
export interface McpBridge {
  /** External tools to register with the Letta session. */
  tools: AnyAgentTool[];
  /** Disconnects every server; safe to call more than once. */
  close(): Promise<void>;
}

interface ConnectOptions {
  /** Working directory the servers are spawned in. */
  cwd?: string;
  /** Diagnostic sink (stderr in production). */
  log?: (message: string) => void;
}

const EMPTY_BRIDGE: McpBridge = { tools: [], close: async () => {} };

const CLIENT_INFO = { name: "letta-acp", version: "1" };

/**
 * Connects the MCP servers a client passed in `session/new`, exposing their
 * tools as Letta external tools.
 *
 * The Letta harness has no MCP client of its own on this path, so the adapter
 * is the client: it spawns each stdio server, lists its tools once at session
 * setup, and proxies `tools/call` from the tool handlers the SDK registers.
 * Tools are namespaced `mcp__<server>__<tool>` (the convention Letta and
 * Claude Code both use) so two servers exporting `search` don't collide.
 *
 * A server that fails to start or list tools is logged and skipped — a broken
 * MCP server must not fail `session/new` and take the whole session with it.
 * Only the stdio transport is supported, which is why `initialize` advertises
 * no `mcpCapabilities`: http/sse servers are dropped with a warning rather
 * than silently ignored.
 */
export async function connectMcpServers(
  servers: readonly McpServer[] | undefined,
  options: ConnectOptions = {},
): Promise<McpBridge> {
  const log = options.log ?? (() => {});
  if (!servers || servers.length === 0) return EMPTY_BRIDGE;

  const clients: Client[] = [];
  const tools: AnyAgentTool[] = [];
  const taken = new Set<string>();

  for (const server of servers) {
    const transport = serverTransport(server);
    if (!transport) {
      log(
        `mcp: skipping server "${server.name}" — only the stdio transport is supported`,
      );
      continue;
    }
    try {
      const client = new Client(CLIENT_INFO);
      await client.connect(
        new StdioClientTransport({
          command: transport.command,
          args: transport.args,
          env: { ...getDefaultEnvironment(), ...transport.env },
          ...(options.cwd ? { cwd: options.cwd } : {}),
          stderr: "inherit",
        }),
      );
      clients.push(client);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const name = uniqueName(
          `mcp__${sanitize(server.name)}__${sanitize(tool.name)}`,
          taken,
        );
        tools.push(bridgeTool(client, server.name, tool, name));
      }
      log(
        `mcp: connected "${server.name}" (${listed.tools.length} tool${
          listed.tools.length === 1 ? "" : "s"
        })`,
      );
    } catch (error) {
      log(`mcp: server "${server.name}" unavailable: ${String(error)}`);
    }
  }

  if (clients.length === 0) return EMPTY_BRIDGE;

  let closed = false;
  return {
    tools,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        clients.map(async (client) => {
          try {
            await client.close();
          } catch {
            // best-effort cleanup: the session is going away regardless
          }
        }),
      );
    },
  };
}

interface StdioTransportConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Stdio spawn config for an ACP MCP server entry, or null for the http/sse
 * transports. The stdio variant is the untagged one in the ACP schema, so a
 * missing `type` means stdio.
 */
function serverTransport(server: McpServer): StdioTransportConfig | null {
  const type = (server as { type?: string }).type;
  if (type !== undefined && type !== "stdio") return null;
  const stdio = server as {
    command?: unknown;
    args?: unknown;
    env?: unknown;
  };
  if (typeof stdio.command !== "string" || stdio.command.length === 0) {
    return null;
  }
  const args = Array.isArray(stdio.args)
    ? stdio.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const env: Record<string, string> = {};
  if (Array.isArray(stdio.env)) {
    for (const entry of stdio.env) {
      if (!entry || typeof entry !== "object") continue;
      const { name, value } = entry as { name?: unknown; value?: unknown };
      if (typeof name === "string" && typeof value === "string") {
        env[name] = value;
      }
    }
  }
  return { command: stdio.command, args, env };
}

interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

function bridgeTool(
  client: Client,
  serverName: string,
  tool: McpToolDefinition,
  name: string,
): AnyAgentTool {
  return {
    name,
    label: tool.title ?? tool.name,
    description:
      tool.description && tool.description.trim().length > 0
        ? tool.description
        : `The ${tool.name} tool from the ${serverName} MCP server.`,
    parameters: toolParameters(tool.inputSchema),
    execute: async (_toolCallId, args, signal) => {
      const result = await client.callTool(
        {
          name: tool.name,
          arguments: isRecord(args) ? args : {},
        },
        undefined,
        signal ? { signal } : undefined,
      );
      const content = toToolResultContent(result.content);
      if (result.isError) {
        throw new Error(
          content
            .map((item) => item.text ?? "")
            .filter(Boolean)
            .join("\n") || `${tool.name} failed`,
        );
      }
      return { content };
    },
  };
}

/** MCP tool schemas are JSON Schema already; keep an object shape regardless. */
function toolParameters(inputSchema: unknown): Record<string, unknown> {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema;
  }
  return { type: "object", properties: {} };
}

/**
 * MCP content blocks -> Letta tool-result content. Text and images map
 * directly; anything else (audio, embedded resources) is rendered as text so
 * the model still sees it rather than silently losing the block.
 */
function toToolResultContent(content: unknown): AgentToolResultContent[] {
  if (!Array.isArray(content)) return [];
  const mapped: AgentToolResultContent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      mapped.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      mapped.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }
    mapped.push({ type: "text", text: JSON.stringify(block) });
  }
  return mapped;
}

/** Tool names reach the model API, which only accepts [A-Za-z0-9_-]. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${name}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

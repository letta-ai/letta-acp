/**
 * Minimal stdio MCP server used by the MCP bridge tests.
 *
 * Exposes two tools: `echo`, which returns its argument plus an env var the
 * client passed at spawn time, and `explode`, which returns an MCP error
 * result. Hand-rolled rather than built on the MCP server SDK so the test
 * exercises the wire protocol the adapter's client actually speaks.
 */
const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "explode",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {} },
  },
];

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function handle(message: Record<string, unknown>): void {
  const { id, method, params } = message as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
      });
      return;
    case "tools/list":
      respond(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "explode") {
        respond(id, {
          content: [{ type: "text", text: "tool blew up" }],
          isError: true,
        });
        return;
      }
      respond(id, {
        content: [
          {
            type: "text",
            text: `echo:${String(args.text)}:${process.env.MOCK_MCP_TOKEN ?? ""}`,
          },
        ],
      });
      return;
    }
    default:
      // Notifications (no id) need no reply; unknown requests get an error.
      if (id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown method: ${method}` },
          })}\n`,
        );
      }
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffer.indexOf("\n");
  }
});

import { writeFileSync } from "node:fs";

const marker = process.env.MCP_SHUTDOWN_MARKER;
const pidFile = process.env.MCP_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line) as {
        id?: unknown;
        method?: string;
      };
      if (message.method === "initialize") {
        respond(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stubborn-test-server", version: "1.0.0" },
        });
      } else if (message.method === "tools/list") {
        respond(message.id, { tools: [] });
      }
    }
    newline = buffer.indexOf("\n");
  }
});

// Deliberately survive stdin EOF. The SDK must finish its shutdown sequence
// and signal the process rather than relying on the adapter's forced exit.
setInterval(() => {}, 1_000);

process.on("SIGTERM", () => {
  if (marker) writeFileSync(marker, "terminated");
  process.exit(0);
});

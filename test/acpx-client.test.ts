import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/session-registry.js";

interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

type WireMessage = Record<string, unknown>;

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function startFakeAppServer() {
  const server = Bun.serve<{ channel: "control" | "stream" }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const channel = new URL(request.url).searchParams.get("channel") === "stream"
        ? "stream"
        : "control";
      if (server.upgrade(request, { data: { channel } })) return;
      return new Response("Expected websocket upgrade", { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as WireMessage;
        if (socket.data.channel !== "control") return;

        switch (message.type) {
          case "runtime_start": {
            const requestId = requiredString(message.request_id);
            socket.send(JSON.stringify({
              type: "runtime_start_response",
              request_id: requestId,
              success: true,
              runtime: TEST_RUNTIME,
              agent: { id: TEST_RUNTIME.agent_id, model: "test/model", tools: [] },
              conversation: {
                id: TEST_RUNTIME.conversation_id,
                agent_id: TEST_RUNTIME.agent_id,
              },
            }));
            return;
          }
          case "conversation_retrieve":
            socket.send(JSON.stringify({
              type: "conversation_retrieve_response",
              request_id: requiredString(message.request_id),
              success: true,
              conversation: TEST_CONVERSATION,
            }));
            return;
          case "conversation_messages_list":
            socket.send(JSON.stringify({
              type: "conversation_messages_list_response",
              request_id: requiredString(message.request_id),
              success: true,
              messages: [],
              has_more: false,
            }));
            return;
          case "list_models":
            socket.send(JSON.stringify({
              type: "list_models_response",
              request_id: requiredString(message.request_id),
              success: true,
              entries: [{
                id: "test-model",
                handle: "test/model",
                label: "Test Model",
                description: "Deterministic test model",
                isDefault: true,
              }],
              available_handles: ["test/model"],
            }));
            return;
          case "input": {
            const payload = message.payload as WireMessage;
            if (payload.kind !== "create_message") return;
            sendDelta(socket, {
              message_type: "tool_call_message",
              run_id: "run-acpx",
              tool_calls: [{
                id: "call-acpx",
                name: "Read",
                arguments: JSON.stringify({ file_path: "/tmp/example.txt" }),
              }],
            });
            sendDelta(socket, {
              message_type: "tool_return_message",
              run_id: "run-acpx",
              tool_call_id: "call-acpx",
              tool_return: "example contents",
              status: "success",
            });
            sendDelta(socket, {
              message_type: "assistant_message",
              run_id: "run-acpx",
              content: "ACPX_OK",
            });
            sendDelta(socket, {
              message_type: "stop_reason",
              run_id: "run-acpx",
              stop_reason: "end_turn",
            });
            return;
          }
        }
      },
    },
  });
  servers.push(server);
  return `ws://${server.hostname}:${server.port}`;
}

const TEST_RUNTIME: RuntimeScope = {
  agent_id: "agent-acpx-test",
  conversation_id: "conv-acpx-test",
};

const TEST_CONVERSATION = {
  id: TEST_RUNTIME.conversation_id,
  agent_id: TEST_RUNTIME.agent_id,
  summary: "ACP client compatibility session",
  archived: false,
  updated_at: "2026-07-29T12:00:00.000Z",
};

function sendDelta(
  socket: { send(data: string): unknown },
  delta: WireMessage,
): void {
  socket.send(JSON.stringify({
    type: "stream_delta",
    runtime: TEST_RUNTIME,
    delta,
  }));
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty request id");
  }
  return value;
}

async function runAcpx(
  format: "json" | "quiet",
  command: string[] = ["exec", "Exercise the ACP tool lifecycle."],
  seedSession = false,
) {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-acpx-"));
  tempDirs.push(home);
  const appServerUrl = startFakeAppServer();
  const cwd = join(import.meta.dir, "..");
  if (seedSession) {
    const registry = new SessionRegistry(
      join(home, ".letta", "letta-acp", "sessions"),
      `remote:${appServerUrl}`,
    );
    await registry.record(TEST_RUNTIME.agent_id, TEST_RUNTIME.conversation_id, cwd);
  }

  const acpxPath = join(import.meta.dir, "..", "node_modules", ".bin", "acpx");
  const agentPath = join(import.meta.dir, "..", "src", "index.ts");
  const child = Bun.spawn(
    [
      acpxPath,
      "--agent",
      `${process.execPath} ${agentPath}`,
      "--format",
      format,
      "--timeout",
      "5",
      ...command,
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        LETTA_ACP_BACKEND: "remote",
        LETTA_APP_SERVER_URL: appServerUrl,
        LETTA_AGENT_ID: TEST_RUNTIME.agent_id,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`acpx exited ${exitCode}:\n${stderr}\n${stdout}`);
  }
  return { stdout, stderr, home, appServerUrl, cwd };
}

async function verifyMcpShutdownOnClientDisconnect(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-mcp-shutdown-"));
  tempDirs.push(home);
  const marker = join(home, "shutdown-marker");
  const pidFile = join(home, "mcp-pid");
  const appServerUrl = startFakeAppServer();
  const agentPath = join(import.meta.dir, "..", "src", "index.ts");
  const mcpPath = join(import.meta.dir, "fixtures", "stubborn-mcp-server.ts");
  const child = Bun.spawn([process.execPath, agentPath], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: home,
      LETTA_ACP_BACKEND: "remote",
      LETTA_APP_SERVER_URL: appServerUrl,
      LETTA_AGENT_ID: TEST_RUNTIME.agent_id,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const send = (message: WireMessage) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush();
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      cwd: join(import.meta.dir, ".."),
      mcpServers: [
        {
          name: "stubborn",
          command: process.execPath,
          args: [mcpPath],
          env: [
            { name: "MCP_SHUTDOWN_MARKER", value: marker },
            { name: "MCP_PID_FILE", value: pidFile },
          ],
        },
      ],
    },
  });

  let buffer = "";
  let sessionOpened = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as WireMessage;
          if (message.id === 2 && message.result) {
            sessionOpened = true;
            break;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (sessionOpened) break;
    }
    expect(sessionOpened).toBe(true);
    expect(existsSync(pidFile)).toBe(true);

    child.stdin.end();
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(8_000).then(() => {
        throw new Error("adapter did not exit after ACP stdin closed");
      }),
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill();
    if (existsSync(pidFile) && !existsSync(marker)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The fixture may already have exited while cleanup raced the test.
        }
      }
    }
  }
}

describe("acpx client compatibility", () => {
  test("completes a prompt through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet");
    expect(stdout.trim()).toBe("ACPX_OK");
  }, 10_000);

  test("records a new ACP session for discovery", async () => {
    const { home, appServerUrl, cwd } = await runAcpx("quiet");
    const registry = new SessionRegistry(
      join(home, ".letta", "letta-acp", "sessions"),
      `remote:${appServerUrl}`,
    );

    expect(await registry.list(TEST_RUNTIME.agent_id, cwd)).toEqual([
      expect.objectContaining({ sessionId: TEST_RUNTIME.conversation_id, cwd }),
    ]);
  }, 10_000);

  test("lists project sessions through a real ACP client", async () => {
    const cwd = join(import.meta.dir, "..");
    const { stdout } = await runAcpx(
      "json",
      ["sessions", "list", "--filter-cwd", cwd],
      true,
    );

    expect(stdout).toContain(TEST_RUNTIME.conversation_id);
    expect(stdout).toContain("ACP client compatibility session");
    expect(stdout).toContain(cwd);
  }, 10_000);

  test("waits for MCP subprocess cleanup after the client disconnects", async () => {
    await verifyMcpShutdownOnClientDisconnect();
  }, 12_000);

  test("emits a complete tool lifecycle as ACP notifications", async () => {
    const { stdout } = await runAcpx("json");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WireMessage);
    const updates = messages
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as WireMessage).update as WireMessage);

    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "tool_call",
      toolCallId: "call-acpx",
      status: "in_progress",
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-acpx",
      status: "completed",
    }));
    expect(updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ACPX_OK" },
    });
  }, 10_000);
});

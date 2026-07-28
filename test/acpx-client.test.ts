import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          case "conversation_messages_list":
            socket.send(JSON.stringify({
              type: "conversation_messages_list_response",
              request_id: requiredString(message.request_id),
              success: true,
              messages: [],
              has_more: false,
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

async function runAcpx(format: "json" | "quiet") {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-acpx-"));
  tempDirs.push(home);
  const appServerUrl = startFakeAppServer();
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
      "exec",
      "Exercise the ACP tool lifecycle.",
    ],
    {
      cwd: join(import.meta.dir, ".."),
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
  return { stdout, stderr };
}

describe("acpx client compatibility", () => {
  test("completes a prompt through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet");
    expect(stdout.trim()).toBe("ACPX_OK");
  }, 10_000);

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

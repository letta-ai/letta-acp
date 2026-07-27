import { describe, expect, test } from "bun:test";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { LettaCodeSocketConstructor } from "@letta-ai/letta-agent-sdk";
import { LettaAcpAgent } from "../src/agent.js";

interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

type WireMessage = Record<string, unknown>;
type SocketListener = (event: unknown) => void;

interface ServerSocket {
  readonly channel: "control" | "stream";
  push(message: WireMessage): void;
}

class FakeAppServer {
  readonly runtimeStartRequestIds: string[] = [];
  readonly approvalResponses: WireMessage[] = [];
  private nextConversation = 0;
  private activeControlSocket: ServerSocket | null = null;
  private activeRuntime: RuntimeScope | null = null;

  socketConstructor(): LettaCodeSocketConstructor {
    const server = this;

    class FakeSocket {
      readyState = 0;
      readonly channel: "control" | "stream";
      private readonly listeners = new Map<string, Set<SocketListener>>();

      constructor(url: string) {
        this.channel = new URL(url).searchParams.get("channel") === "stream"
          ? "stream"
          : "control";
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open", {});
        });
      }

      send(data: string): void {
        server.receive(this, JSON.parse(data) as WireMessage);
      }

      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit("close", {});
      }

      addEventListener(type: string, listener: SocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: SocketListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      push(message: WireMessage): void {
        queueMicrotask(() => {
          this.emit("message", { data: JSON.stringify(message) });
        });
      }

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    return FakeSocket as unknown as LettaCodeSocketConstructor;
  }

  requestPermissionAfterPrompt(): void {
    const socket = this.activeControlSocket;
    const runtime = this.activeRuntime;
    if (!socket || !runtime) {
      throw new Error("No active runtime for late permission request");
    }
    socket.push({
      type: "control_request",
      request_id: "approval-request-after-prompt",
      runtime,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_call_id: "call-after-prompt",
        input: {
          command: "pwd",
          description: "Show working directory after prompt",
        },
      },
    });
  }

  private receive(socket: ServerSocket, message: WireMessage): void {
    if (socket.channel !== "control") {
      throw new Error(`Unexpected command on ${socket.channel} channel`);
    }

    switch (message.type) {
      case "runtime_start": {
        const requestId = requiredString(message.request_id, "runtime_start.request_id");
        const conversationId = `conv-test-${++this.nextConversation}`;
        const runtime = {
          agent_id: "agent-test",
          conversation_id: conversationId,
        };
        this.runtimeStartRequestIds.push(requestId);
        socket.push({
          type: "runtime_start_response",
          request_id: requestId,
          success: true,
          runtime,
          agent: { id: "agent-test", model: "test/model", tools: [] },
          conversation: { id: conversationId, agent_id: "agent-test" },
        });
        return;
      }
      case "conversation_messages_list":
        socket.push({
          type: "conversation_messages_list_response",
          request_id: requiredString(
            message.request_id,
            "conversation_messages_list.request_id",
          ),
          success: true,
          messages: [],
          has_more: false,
        });
        return;
      case "input":
        this.handleInput(socket, message);
        return;
      default:
        throw new Error(`Unhandled fake app-server command: ${String(message.type)}`);
    }
  }

  private handleInput(socket: ServerSocket, message: WireMessage): void {
    const runtime = message.runtime as RuntimeScope;
    const payload = message.payload as Record<string, unknown>;
    this.activeControlSocket = socket;
    this.activeRuntime = runtime;

    if (payload.kind === "approval_response") {
      this.approvalResponses.push(payload);
      this.pushDelta(socket, runtime, {
        message_type: "tool_return_message",
        run_id: "run-approval",
        tool_call_id: "call-approval",
        tool_return: "write completed",
        status: "success",
      });
      this.pushDelta(socket, runtime, {
        message_type: "assistant_message",
        run_id: "run-approval",
        content: "APPROVAL_OK",
      });
      socket.push({
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: [],
        },
      });
      return;
    }

    if (payload.kind !== "create_message") {
      throw new Error(`Unhandled fake input payload: ${String(payload.kind)}`);
    }

    const serializedMessages = JSON.stringify(payload.messages);
    const isApprovalPrompt = serializedMessages.includes("approval prompt");
    if (isApprovalPrompt) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-approval",
        tool_calls: [
          {
            id: "call-approval",
            name: "Write",
            arguments: JSON.stringify({ file_path: "/tmp/test.txt" }),
          },
        ],
      });
      socket.push({
        type: "control_request",
        request_id: "approval-request-1",
        runtime,
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          tool_call_id: "call-approval",
          input: { file_path: "/tmp/test.txt" },
        },
      });
      this.pushDelta(socket, runtime, {
        message_type: "stop_reason",
        run_id: "run-approval",
        stop_reason: "requires_approval",
      });
      return;
    }

    if (serializedMessages.includes("edit prompt")) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-edit",
        tool_calls: [
          {
            id: "call-edit",
            name: "Edit",
            arguments: JSON.stringify({
              file_path: "/tmp/example.ts",
              old_string: "const value = 1;",
              new_string: "const value = 2;",
            }),
          },
        ],
      });
      this.pushDelta(socket, runtime, {
        message_type: "tool_return_message",
        run_id: "run-edit",
        tool_call_id: "call-edit",
        tool_return: JSON.stringify({
          message: "Successfully replaced 1 occurrence",
          replacements: 1,
          startLine: 12,
        }),
        status: "success",
      });
      this.pushDelta(socket, runtime, {
        message_type: "stop_reason",
        run_id: "run-edit",
        stop_reason: "end_turn",
      });
      return;
    }

    this.pushDelta(socket, runtime, {
      message_type: "assistant_message",
      run_id: "run-prompt",
      content: "PROMPT_OK",
    });
    this.pushDelta(socket, runtime, {
      message_type: "stop_reason",
      run_id: "run-prompt",
      stop_reason: "end_turn",
    });
  }

  private pushDelta(
    socket: ServerSocket,
    runtime: RuntimeScope,
    delta: WireMessage,
  ): void {
    socket.push({ type: "stream_delta", runtime, delta });
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function createAgent(server: FakeAppServer): LettaAcpAgent {
  return new LettaAcpAgent({
    clientOptions: {
      backend: "local",
      appServer: {
        url: "ws://fake-app-server.test/ws",
        WebSocket: server.socketConstructor(),
        requestTimeoutMs: 1_000,
      },
    },
    agentId: "agent-test",
    permissionMode: "standard",
  });
}

function createContext() {
  const updates: WireMessage[] = [];
  const permissionRequests: WireMessage[] = [];
  const context = {
    notify: async (_method: unknown, params: { update: WireMessage }) => {
      updates.push(params.update);
    },
    request: async (_method: unknown, params: WireMessage) => {
      permissionRequests.push(params);
      return {
        outcome: { outcome: "selected" as const, optionId: "allow_once" },
      };
    },
  } as unknown as AgentContext;
  return { context, updates, permissionRequests };
}

async function openSession(agent: LettaAcpAgent, context: AgentContext) {
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  return agent.newSession(
    { cwd: "/tmp/letta-acp-test", mcpServers: [] },
    context,
  );
}

describe("Agent SDK app-server integration", () => {
  test("starts repeated sessions with distinct runtime request ids", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();

    try {
      const sessionIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        sessionIds.push((await openSession(agent, context)).sessionId);
      }

      expect(sessionIds).toEqual([
        "conv-test-1",
        "conv-test-2",
        "conv-test-3",
      ]);
      expect(new Set(server.runtimeStartRequestIds).size).toBe(3);
    } finally {
      agent.shutdown();
    }
  });

  test("streams an assistant response through a complete prompt turn", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PROMPT_OK" },
      });
    } finally {
      agent.shutdown();
    }
  });

  test("renders an SDK Edit call as a native ACP diff", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "edit prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "call-edit",
          content: [
            {
              type: "diff",
              path: "/tmp/example.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;",
            },
          ],
        }),
      );
      const completed = updates.find(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "call-edit" &&
          update.status === "completed",
      );
      expect(completed).toEqual(
        expect.objectContaining({
          rawOutput: {
            message: "Successfully replaced 1 occurrence",
            replacements: 1,
            startLine: 12,
          },
          locations: [{ path: "/tmp/example.ts", line: 12 }],
        }),
      );
      expect(completed).not.toHaveProperty("content");
    } finally {
      agent.shutdown();
    }
  });

  test("routes a permission request after the prompt handler returns", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      expect(result).toEqual({ stopReason: "end_turn" });

      server.requestPermissionAfterPrompt();
      for (
        let attempt = 0;
        attempt < 20 && server.approvalResponses.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(permissionRequests).toContainEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
          toolCall: expect.objectContaining({
            title: "Bash: Show working directory after prompt",
          }),
        }),
      );
      expect(server.approvalResponses).toContainEqual(
        expect.objectContaining({
          kind: "approval_response",
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({ behavior: "allow" }),
        }),
      );
    } finally {
      agent.shutdown();
    }
  });

  test("recovers a prompt after an approved mutating tool call", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "approval prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        sessionId: session.sessionId,
        toolCall: { title: "Write: /tmp/test.txt" },
      });
      expect(server.approvalResponses).toHaveLength(1);
      expect(server.approvalResponses[0]).toMatchObject({
        kind: "approval_response",
        request_id: "approval-request-1",
        decision: { behavior: "allow" },
      });
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-approval",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "write completed" },
            },
          ],
        }),
      );
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "APPROVAL_OK" },
      });
    } finally {
      agent.shutdown();
    }
  });
});

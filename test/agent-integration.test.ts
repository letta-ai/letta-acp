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
  private approvalWaiters: Array<(payload: WireMessage) => void> = [];

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

  /** Resolves with the next approval_response the adapter sends back. */
  nextApprovalResponse(): Promise<WireMessage> {
    return new Promise((resolve) => {
      this.approvalWaiters.push(resolve);
    });
  }

  requestPermissionAfterPrompt(
    overrides: {
      requestId?: string;
      toolName?: string;
      toolCallId?: string;
      input?: Record<string, unknown>;
    } = {},
  ): void {
    const socket = this.activeControlSocket;
    const runtime = this.activeRuntime;
    if (!socket || !runtime) {
      throw new Error("No active runtime for late permission request");
    }
    socket.push({
      type: "control_request",
      request_id: overrides.requestId ?? "approval-request-after-prompt",
      runtime,
      request: {
        subtype: "can_use_tool",
        tool_name: overrides.toolName ?? "Bash",
        tool_call_id: overrides.toolCallId ?? "call-after-prompt",
        input: overrides.input ?? {
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
      case "abort_message":
        socket.push({
          type: "abort_message_response",
          request_id: requiredString(
            message.request_id,
            "abort_message.request_id",
          ),
          success: true,
        });
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
      for (const waiter of this.approvalWaiters.splice(0)) waiter(payload);
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

    const promptText = JSON.stringify(payload.messages);
    if (promptText.includes("fragmented prompt")) {
      this.streamFragmentedToolCall(socket, runtime);
      return;
    }
    if (promptText.includes("busy idle prompt")) {
      this.reportIdleWhileRunning(socket, runtime, { thenContinue: true });
      return;
    }
    if (promptText.includes("silent idle prompt")) {
      this.reportIdleWhileRunning(socket, runtime, { thenContinue: false });
      return;
    }

    const isApprovalPrompt = promptText.includes("approval prompt");
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

    if (promptText.includes("edit prompt")) {
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

  /**
   * Streams one tool call as the app-server really does: an opening chunk
   * carrying the name plus a slice of the arguments, then continuation chunks
   * that carry argument text only (and therefore no tool name).
   */
  private streamFragmentedToolCall(
    socket: ServerSocket,
    runtime: RuntimeScope,
  ): void {
    const fragments = [
      { name: "Bash", arguments: '{"command":"git status"' },
      { arguments: ',"description":"Show the ' },
      { arguments: 'working tree status"}' },
    ];
    for (const fragment of fragments) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-fragmented",
        tool_calls: [{ id: "call-fragmented", ...fragment }],
      });
    }
    this.pushDelta(socket, runtime, {
      message_type: "tool_return_message",
      run_id: "run-fragmented",
      tool_call_id: "call-fragmented",
      tool_return: "nothing to commit",
      status: "success",
    });
    this.pushDelta(socket, runtime, {
      message_type: "stop_reason",
      run_id: "run-fragmented",
      stop_reason: "end_turn",
    });
  }

  /**
   * Reports WAITING_ON_INPUT while still listing an active run — the shape
   * that makes the SDK synthesize a successful, stop-reason-less result even
   * though the agent is mid-step. `thenContinue` decides whether the run
   * really was still going (after a beat, as a real server would take) or
   * whether the status was simply stale and nothing more arrives.
   */
  private reportIdleWhileRunning(
    socket: ServerSocket,
    runtime: RuntimeScope,
    options: { thenContinue: boolean },
  ): void {
    this.pushDelta(socket, runtime, {
      message_type: "assistant_message",
      run_id: "run-first",
      content: "WORKING",
    });
    socket.push({
      type: "update_loop_status",
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: ["run-second"],
      },
    });
    if (!options.thenContinue) return;
    // A real server takes a beat before the next step; without the delay the
    // continuation lands in the same microtask batch and hides the race.
    setTimeout(() => {
      this.pushDelta(socket, runtime, {
        message_type: "assistant_message",
        run_id: "run-second",
        content: "STILL_WORKING",
      });
      // The turn tracker was already consumed by the contradicted result, so
      // the run ends the way post-approval rounds do: on a real idle status.
      socket.push({
        type: "update_loop_status",
        runtime,
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
      });
    }, 20);
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

function createAgent(
  server: FakeAppServer,
  overrides: {
    outOfTurnPermissionTimeoutMs?: number;
    prematureResultGraceMs?: number;
  } = {},
): LettaAcpAgent {
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
    ...overrides,
  });
}

function createContext(options: { answerPermissions?: boolean } = {}) {
  const answerPermissions = options.answerPermissions ?? true;
  const updates: WireMessage[] = [];
  const permissionRequests: WireMessage[] = [];
  const permissionSignals: Array<AbortSignal | undefined> = [];
  const context = {
    notify: async (_method: unknown, params: { update: WireMessage }) => {
      updates.push(params.update);
    },
    request: async (
      _method: unknown,
      params: WireMessage,
      requestOptions?: { cancellationSignal?: AbortSignal },
    ) => {
      permissionRequests.push(params);
      permissionSignals.push(requestOptions?.cancellationSignal);
      if (!answerPermissions) return new Promise(() => {});
      return {
        outcome: { outcome: "selected" as const, optionId: "allow_once" },
      };
    },
  } as unknown as AgentContext;
  return { context, updates, permissionRequests, permissionSignals };
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

  test("streams fragmented tool arguments as one tool card", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fragmented prompt" }],
        },
        context,
      );
      expect(result).toEqual({ stopReason: "end_turn" });

      expect(
        updates.filter((update) => update.toolCallId === "call-fragmented"),
      ).toEqual([
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-fragmented",
          title: "Bash",
          kind: "execute",
          status: "in_progress",
          rawInput: { raw: '{"command":"git status"' },
          locations: [],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          title: "Bash: Show the working tree status",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "git status",
            description: "Show the working tree status",
          },
          locations: [],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          status: "completed",
          rawOutput: "nothing to commit",
          content: [
            {
              type: "content",
              content: { type: "text", text: "nothing to commit" },
            },
          ],
        },
      ]);
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
    const { context, permissionRequests, permissionSignals } = createContext();

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

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          kind: "approval_response",
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({ behavior: "allow" }),
        }),
      );
      expect(permissionRequests).toContainEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
          toolCall: expect.objectContaining({
            title: "Bash: Show working directory after prompt",
          }),
        }),
      );
      // Out-of-turn requests carry a deadline the client can observe.
      expect(permissionSignals.at(-1)).toBeInstanceOf(AbortSignal);
    } finally {
      agent.shutdown();
    }
  });

  test("attaches a permission request to the tool call it belongs to", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      // Leaves a streamed Bash call as the most recent one, so name matching
      // cannot find the Write call the approval is actually for.
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fragmented prompt" }],
        },
        context,
      );

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "approval-unrelated-tool",
        toolName: "Write",
        toolCallId: "call-write",
        input: { file_path: "/tmp/example.ts" },
      });
      await approval;

      // A synthetic id here would render a permission card the client can
      // never reconcile with the tool call in the stream.
      expect(permissionRequests.at(-1)).toEqual(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            toolCallId: "call-write",
            title: "Write: /tmp/example.ts",
            kind: "edit",
          }),
        }),
      );
    } finally {
      agent.shutdown();
    }
  });

  test("denies a permission request that lands after cancellation", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      await agent.cancel({ sessionId: session.sessionId });

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({
            behavior: "deny",
            message: "Prompt turn was cancelled",
          }),
        }),
      );
      // The user already pressed stop; they should not be asked again.
      expect(permissionRequests).toEqual([]);
    } finally {
      agent.shutdown();
    }
  });

  test("denies an out-of-turn permission request the client never answers", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { outOfTurnPermissionTimeoutMs: 10 });
    const { context, permissionSignals } = createContext({
      answerPermissions: false,
    });

    try {
      const session = await openSession(agent, context);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({
            behavior: "deny",
            message:
              "Permission request timed out after 10ms while trying to " +
              "approve Bash outside a prompt turn",
          }),
        }),
      );
      expect(permissionSignals.at(-1)?.aborted).toBe(true);
    } finally {
      agent.shutdown();
    }
  });

  test("keeps the turn open when the server is still running a job", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "busy idle prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      // Returning at the first (contradicted) completion would end the prompt
      // before this arrived, stranding the rest of the turn outside it.
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "STILL_WORKING" },
      });
    } finally {
      agent.shutdown();
    }
  });

  test("ends the turn when a contradicted completion is never followed up", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { prematureResultGraceMs: 20 });
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);
      // The status was simply stale: nothing follows it. The grace period has
      // to expire on its own, or the prompt would hang forever.
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "silent idle prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
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

import { describe, expect, test } from "bun:test";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import { LettaAcpAgent } from "../src/agent.js";

function createHarness() {
  const updates: Array<Record<string, unknown>> = [];
  const context = {
    notify: async (_method: string, params: { update: Record<string, unknown> }) => {
      updates.push(params.update);
    },
  } as unknown as AgentContext;
  const agent = new LettaAcpAgent({
    clientOptions: { backend: "local" },
    permissionMode: "standard",
  });
  const state = {
    session: {},
    clientContext: context,
    lastToolCall: null,
    toolInputs: new Map(),
    diffToolCalls: new Set(),
    alwaysAllowed: new Set(),
    cancelled: false,
    modeId: "standard",
    cwd: "/tmp",
  };
  const forwardMessage = (
    agent as unknown as {
      forwardMessage(
        sessionId: string,
        state: unknown,
        message: SDKMessage,
        cx: AgentContext,
      ): Promise<boolean>;
    }
  ).forwardMessage.bind(agent);
  return { agent, context, forwardMessage, state, updates };
}

describe("ACP tool updates", () => {
  test("updates one tool card as fragmented arguments become complete", async () => {
    const { agent, context, forwardMessage, state, updates } = createHarness();

    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_call",
        toolCallId: "call-test",
        toolName: "Bash",
        toolInput: { raw: '{"command":"pwd","descr' },
        rawArguments: '{"command":"pwd","descr',
        uuid: "message-test",
      },
      context,
    );
    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_call",
        toolCallId: "call-test",
        toolName: "Bash",
        toolInput: { raw: 'iption":"Show working directory"}' },
        rawArguments: 'iption":"Show working directory"}',
        uuid: "message-test",
      },
      context,
    );

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "call-test",
        title: "Bash",
      }),
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-test",
        title: "Bash: Show working directory",
        rawInput: {
          command: "pwd",
          description: "Show working directory",
        },
      }),
    ]);
    agent.shutdown();
  });

  test("adds a diff when fragmented Edit input becomes complete and preserves it", async () => {
    const { agent, context, forwardMessage, state, updates } = createHarness();

    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_call",
        toolCallId: "call-edit",
        toolName: "Edit",
        toolInput: { raw: "partial" },
        rawArguments:
          '{"file_path":"/tmp/example.ts","old_string":"const value = 1;","new_',
        uuid: "message-edit-1",
      },
      context,
    );
    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_call",
        toolCallId: "call-edit",
        toolName: "Edit",
        toolInput: { raw: "partial" },
        rawArguments: 'string":"const value = 2;"}',
        uuid: "message-edit-2",
      },
      context,
    );
    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_result",
        toolCallId: "call-edit",
        content:
          '{"message":"Successfully replaced 1 occurrence","replacements":1,"startLine":12}',
        isError: false,
        uuid: "message-edit-result",
      },
      context,
    );

    expect(updates[0]).toEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "call-edit",
      }),
    );
    expect(updates[0]).not.toHaveProperty("content");
    expect(updates[1]).toEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
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
    expect(updates[2]).toEqual(
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-edit",
        status: "completed",
        rawOutput: {
          message: "Successfully replaced 1 occurrence",
          replacements: 1,
          startLine: 12,
        },
        locations: [{ path: "/tmp/example.ts", line: 12 }],
      }),
    );
    expect(updates[2]).not.toHaveProperty("content");
    expect(state.toolInputs.size).toBe(0);
    expect(state.diffToolCalls.size).toBe(0);
    agent.shutdown();
  });

  test("replaces an edit diff with readable content when the tool fails", async () => {
    const { agent, context, forwardMessage, state, updates } = createHarness();
    const input = {
      file_path: "/tmp/example.ts",
      old_string: "before",
      new_string: "after",
    };

    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_call",
        toolCallId: "call-edit",
        toolName: "Edit",
        toolInput: input,
        rawArguments: JSON.stringify(input),
        uuid: "message-edit",
      },
      context,
    );
    await forwardMessage(
      "conv-test",
      state,
      {
        type: "tool_result",
        toolCallId: "call-edit",
        content: "old_string was not found",
        isError: true,
        uuid: "message-edit-result",
      },
      context,
    );

    expect(updates[1]).toEqual(
      expect.objectContaining({
        status: "failed",
        rawOutput: "old_string was not found",
        content: [
          {
            type: "content",
            content: { type: "text", text: "old_string was not found" },
          },
        ],
      }),
    );
    agent.shutdown();
  });
});

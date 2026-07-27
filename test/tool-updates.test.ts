import { describe, expect, test } from "bun:test";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import { LettaAcpAgent } from "../src/agent.js";

describe("ACP tool updates", () => {
  test("updates one tool card as fragmented arguments become complete", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const cx = {
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
      clientContext: cx,
      lastToolCall: null,
      toolInputs: new Map(),
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
      cx,
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
      cx,
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
});

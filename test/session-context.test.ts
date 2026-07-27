import { describe, expect, test } from "bun:test";
import { methods, type AgentContext } from "@agentclientprotocol/sdk";
import type { CanUseToolResponse } from "@letta-ai/letta-agent-sdk";
import { LettaAcpAgent } from "../src/agent.js";

describe("session-scoped ACP client context", () => {
  test("routes a permission request after the originating prompt handler has returned", async () => {
    let requestedMethod: string | undefined;
    const clientContext = {
      request: async (method: string) => {
        requestedMethod = method;
        return {
          outcome: { outcome: "selected", optionId: "allow_once" },
        };
      },
    } as unknown as AgentContext;
    const agent = new LettaAcpAgent({
      clientOptions: { backend: "local" },
      permissionMode: "standard",
    });
    const sessions = (
      agent as unknown as { sessions: Map<string, unknown> }
    ).sessions;
    sessions.set("conv-test", {
      session: {},
      clientContext,
      lastToolCall: { id: "call-test", name: "Bash" },
      toolInputs: new Map(),
      alwaysAllowed: new Set(),
      cancelled: false,
      modeId: "standard",
      cwd: "/tmp",
    });

    const response = await (
      agent as unknown as {
        requestToolPermission(
          sessionId: string,
          toolName: string,
          toolInput: Record<string, unknown>,
        ): Promise<CanUseToolResponse>;
      }
    ).requestToolPermission("conv-test", "Bash", {
      command: "pwd",
      description: "Show working directory",
    });

    expect(requestedMethod).toBe(methods.client.session.requestPermission);
    expect(response).toEqual({
      behavior: "allow",
      updatedInput: {
        command: "pwd",
        description: "Show working directory",
      },
    });
    agent.shutdown();
  });
});

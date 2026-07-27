import { describe, expect, test } from "bun:test";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import { createEditorTools } from "../src/editor-tools.js";

type RequestOptions = { cancellationSignal?: AbortSignal };
type FakeRequest = (
  method: string,
  params: unknown,
  options?: RequestOptions,
) => Promise<unknown>;

function editorTool(name: string, request: FakeRequest): AnyAgentTool {
  const context = {
    getSessionId: () => "conv-test",
    getPromptContext: () => ({ request }) as unknown as AgentContext,
  };
  const tool = createEditorTools(
    { readTextFile: true, writeTextFile: true },
    context,
    10,
  ).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing editor tool ${name}`);
  return tool;
}

describe("editor filesystem request timeouts", () => {
  test("read_editor_buffer stops waiting when the editor never responds", async () => {
    let signal: AbortSignal | undefined;
    const tool = editorTool("read_editor_buffer", (_method, _params, options) => {
      signal = options?.cancellationSignal;
      return new Promise(() => {});
    });

    await expect(
      tool.execute("call-read", { path: "/tmp/input.ts" }),
    ).rejects.toThrow(
      "Editor request timed out after 10ms while trying to read /tmp/input.ts",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("write_via_editor stops waiting when the editor never responds", async () => {
    let signal: AbortSignal | undefined;
    const tool = editorTool("write_via_editor", (_method, _params, options) => {
      signal = options?.cancellationSignal;
      return new Promise(() => {});
    });

    await expect(
      tool.execute("call-write", {
        path: "/tmp/output.ts",
        content: "updated",
      }),
    ).rejects.toThrow(
      "Editor request timed out after 10ms while trying to write /tmp/output.ts",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("successful editor requests clear their timeout", async () => {
    let signal: AbortSignal | undefined;
    const tool = editorTool("read_editor_buffer", (_method, _params, options) => {
      signal = options?.cancellationSignal;
      return Promise.resolve({ content: "unsaved buffer" });
    });

    const result = await tool.execute("call-read", { path: "/tmp/input.ts" });
    expect(result).toEqual({
      content: [{ type: "text", text: "unsaved buffer" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(false);
  });
});

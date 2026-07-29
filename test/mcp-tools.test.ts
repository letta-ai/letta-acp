import { describe, expect, test } from "bun:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import { connectMcpServers } from "../src/mcp-tools.js";

const FIXTURE = new URL("./fixtures/mock-mcp-server.ts", import.meta.url)
  .pathname;

function stdioServer(name = "buzz"): McpServer {
  return {
    name,
    command: process.execPath,
    args: [FIXTURE],
    env: [{ name: "MOCK_MCP_TOKEN", value: "from-client" }],
  } as McpServer;
}

describe("MCP bridge", () => {
  test("exposes namespaced tools from a stdio server", async () => {
    const bridge = await connectMcpServers([stdioServer()]);
    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual([
        "mcp__buzz__echo",
        "mcp__buzz__explode",
      ]);
      const echo = bridge.tools[0];
      expect(echo?.description).toBe("Echo the given text back.");
      expect(echo?.parameters).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
      });
    } finally {
      await bridge.close();
    }
  });

  test("proxies tool calls, including the env the client supplied", async () => {
    const bridge = await connectMcpServers([stdioServer()]);
    try {
      const echo = bridge.tools.find((tool) => tool.name === "mcp__buzz__echo");
      const result = await echo?.execute("call-1", { text: "hello" });
      expect(result?.content).toEqual([
        { type: "text", text: "echo:hello:from-client" },
      ]);
    } finally {
      await bridge.close();
    }
  });

  test("surfaces MCP error results as tool failures", async () => {
    const bridge = await connectMcpServers([stdioServer()]);
    try {
      const explode = bridge.tools.find(
        (tool) => tool.name === "mcp__buzz__explode",
      );
      expect(explode?.execute("call-2", {})).rejects.toThrow("tool blew up");
    } finally {
      await bridge.close();
    }
  });

  test("namespaces per server so identical tool names do not collide", async () => {
    const bridge = await connectMcpServers([
      stdioServer("one"),
      stdioServer("two"),
    ]);
    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual([
        "mcp__one__echo",
        "mcp__one__explode",
        "mcp__two__echo",
        "mcp__two__explode",
      ]);
    } finally {
      await bridge.close();
    }
  });

  test("skips a server that cannot start instead of failing the session", async () => {
    const logs: string[] = [];
    const bridge = await connectMcpServers(
      [
        {
          name: "broken",
          command: "/nonexistent/mcp-server",
          args: [],
          env: [],
        } as McpServer,
        stdioServer(),
      ],
      { log: (message) => logs.push(message) },
    );
    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual([
        "mcp__buzz__echo",
        "mcp__buzz__explode",
      ]);
      expect(logs.some((line) => line.includes('"broken" unavailable'))).toBe(
        true,
      );
    } finally {
      await bridge.close();
    }
  });

  test("skips non-stdio transports with a warning", async () => {
    const logs: string[] = [];
    const bridge = await connectMcpServers(
      [
        {
          type: "http",
          name: "remote",
          url: "https://example.test/mcp",
          headers: [],
        } as unknown as McpServer,
      ],
      { log: (message) => logs.push(message) },
    );
    expect(bridge.tools).toEqual([]);
    expect(
      logs.some((line) => line.includes("only the stdio transport")),
    ).toBe(true);
    await bridge.close();
  });

  test("no servers means no work and no tools", async () => {
    const bridge = await connectMcpServers([]);
    expect(bridge.tools).toEqual([]);
    await bridge.close();
  });
});

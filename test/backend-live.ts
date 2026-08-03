import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Backend = "local" | "cloud";

interface BackendExpectation {
  apiKey: "OPENAI_API_KEY" | "LETTA_API_KEY";
  forbiddenApiKey: "OPENAI_API_KEY" | "LETTA_API_KEY";
  model: string;
  marker: string;
}

class LiveBackendError extends Error {
  constructor(
    cause: unknown,
    readonly stderr: string,
    readonly agentId: string | undefined,
    readonly sessionId: string | undefined,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const expectations: Record<Backend, BackendExpectation> = {
  local: {
    apiKey: "OPENAI_API_KEY",
    forbiddenApiKey: "LETTA_API_KEY",
    model: "openai/gpt-5.6-luna",
    marker: "ACP_LOCAL_OK",
  },
  cloud: {
    apiKey: "LETTA_API_KEY",
    forbiddenApiKey: "OPENAI_API_KEY",
    model: "letta/auto",
    marker: "ACP_CLOUD_OK",
  },
};

const backend = process.argv[2] as Backend | undefined;
if (!backend || !(backend in expectations)) {
  throw new Error("Usage: bun test/backend-live.ts <local|cloud>");
}

const expectation = expectations[backend];
const apiKey = process.env[expectation.apiKey];
if (!apiKey) {
  throw new Error(
    `Live ${backend} ACP test requires ${expectation.apiKey}.`,
  );
}

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), `letta-acp-${backend}-live-`));
const childEnv = { ...process.env };
delete childEnv[expectation.forbiddenApiKey];
childEnv[expectation.apiKey] = apiKey;
childEnv.HOME = home;
childEnv.LETTA_ACP_BACKEND = backend;
childEnv.LETTA_ACP_MODEL = expectation.model;
childEnv.LETTA_ACP_PERMISSION_MODE = "standard";
delete childEnv.LETTA_AGENT_ID;

let sessionId: string | undefined;
let createdAgentId: string | undefined;
let adapterStderr = "";
let primaryError: unknown;

try {
  const result = await exerciseBackend(backend, childEnv, expectation);
  sessionId = result.sessionId;
  createdAgentId = result.agentId;
  adapterStderr = result.stderr;
  console.log(
    `Live ${backend} ACP test passed: listed models, created ${createdAgentId}, and received ${expectation.marker}.`,
  );
} catch (error) {
  primaryError = error;
  if (error instanceof LiveBackendError) {
    sessionId = error.sessionId;
    createdAgentId = error.agentId ?? extractAgentId(adapterStderr);
    if (!adapterStderr) adapterStderr = error.stderr;
  }
} finally {
  if (backend === "cloud") {
    try {
      await deleteCloudAgent(apiKey, createdAgentId, sessionId);
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
      else console.error(`Cloud agent cleanup failed: ${String(cleanupError)}`);
    }
  }
  rmSync(home, { recursive: true, force: true });
}

if (primaryError) {
  const detail = primaryError instanceof Error
    ? primaryError.stack ?? primaryError.message
    : String(primaryError);
  throw new Error(
    `${detail}${adapterStderr ? `\n\nAdapter stderr:\n${adapterStderr}` : ""}`,
  );
}

async function exerciseBackend(
  selectedBackend: Backend,
  env: Record<string, string | undefined>,
  expected: BackendExpectation,
): Promise<{ sessionId: string; agentId: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, join(root, "src", "index.ts")], {
    cwd: root,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrDone = collectStderr(child.stderr, (text) => {
    adapterStderr = text;
    createdAgentId = extractAgentId(text) ?? createdAgentId;
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      child.stdin.write(chunk);
      child.stdin.flush();
    },
    close() {
      child.stdin.end();
    },
  });
  const updates: SessionNotification[] = [];
  const client: Client = {
    requestPermission(params) {
      const reject = params.options.find((option) => option.kind === "reject_once");
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    sessionUpdate(params) {
      updates.push(params);
    },
  };
  const stream = ndJsonStream(output, child.stdout);
  const connection = new ClientSideConnection(() => client, stream);

  try {
    await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "letta-acp-live-test", version: "1" },
      }),
      30_000,
      `${selectedBackend} ACP initialization`,
    );

    const session = await withTimeout(
      connection.newSession({ cwd: root, mcpServers: [] }),
      120_000,
      `${selectedBackend} agent creation`,
    );
    sessionId = session.sessionId;
    const conversationPrefix = selectedBackend === "local"
      ? "local-conv-"
      : "conv-";
    assert(
      sessionId.startsWith(conversationPrefix),
      `Expected a Letta conversation id, received ${sessionId}.`,
    );

    const modelOption = session.configOptions?.find(
      (option) => option.id === "model" && option.type === "select",
    );
    assert(
      modelOption?.type === "select" && modelOption.options.length > 0,
      `${selectedBackend} session did not return model configuration options.`,
    );

    updates.length = 0;
    await withTimeout(
      connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/model" }],
      }),
      60_000,
      `${selectedBackend} model listing`,
    );
    const modelListing = assistantText(updates);
    assert(
      modelListing.includes("Available models:") &&
        modelListing.includes(expected.model),
      `${selectedBackend} /model output did not include ${expected.model}:\n${modelListing}`,
    );

    updates.length = 0;
    await withTimeout(
      connection.prompt({
        sessionId,
        prompt: [{
          type: "text",
          text: `Reply with exactly ${expected.marker} and nothing else. Do not use tools.`,
        }],
      }),
      180_000,
      `${selectedBackend} agent message`,
    );
    const reply = assistantText(updates);
    assert(
      reply.includes(expected.marker),
      `${selectedBackend} agent reply did not include ${expected.marker}:\n${reply}`,
    );

    createdAgentId = extractAgentId(adapterStderr);
    assert(
      createdAgentId?.startsWith("agent-") === true,
      `${selectedBackend} session did not report the newly created agent id.`,
    );
    return { sessionId, agentId: createdAgentId, stderr: adapterStderr };
  } catch (error) {
    throw new LiveBackendError(
      error,
      adapterStderr,
      createdAgentId,
      sessionId,
    );
  } finally {
    child.stdin.end();
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!exited) {
      child.kill();
      await child.exited;
    }
    await stderrDone;
  }
}

async function collectStderr(
  stderr: ReadableStream<Uint8Array>,
  update: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stderr) {
    text += decoder.decode(chunk, { stream: true });
    update(text);
  }
  text += decoder.decode();
  update(text);
}

function assistantText(updates: SessionNotification[]): string {
  return updates
    .map(({ update }) =>
      update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
        ? update.content.text
        : ""
    )
    .join("");
}

function extractAgentId(stderr: string): string | undefined {
  return stderr.match(/created agent (agent-[^\s]+)/)?.[1];
}

async function deleteCloudAgent(
  cloudApiKey: string,
  agentId: string | undefined,
  conversationId: string | undefined,
): Promise<void> {
  const client = new LettaAgentClient({ backend: "cloud", apiKey: cloudApiKey });
  let resolvedAgentId = agentId;
  if (!resolvedAgentId && conversationId) {
    const conversation = await client.conversations.retrieve(conversationId);
    resolvedAgentId = conversation.agent_id;
  }
  if (resolvedAgentId) await client.agents.delete(resolvedAgentId);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

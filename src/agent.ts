import {
  type AgentContext,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import {
  type CanUseToolContext,
  type CanUseToolResponse,
  LettaAgentClient,
  type LettaCodeSession,
  type MessageContentItem,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { authMethodsForClient } from "./auth.js";
import type { LettaAcpConfig } from "./config.js";
import {
  createEditorTools,
  type EditorFsCapabilities,
} from "./editor-tools.js";
import { historyToUpdates } from "./history-replay.js";
import { withAcpRequestTimeout } from "./request-timeout.js";
import {
  isSessionModeId,
  modeAutoAllows,
  sessionModeState,
} from "./session-modes.js";
import {
  buildAvailableCommands,
  isExecuteCommand,
} from "./slash-commands.js";
import {
  accumulateToolInput,
  parseToolOutput,
  type ToolCallInputState,
  toolDiffContent,
  toolKind,
  toolLocations,
  toolOutputLine,
  toolTitle,
} from "./tool-info.js";

interface StreamedToolCall {
  /** First non-placeholder name seen for this tool call. */
  toolName: string;
  input: ToolCallInputState;
  /** Whether the ACP card already contains a native diff. */
  hasDiff: boolean;
}

interface AcpSessionState {
  session: LettaCodeSession;
  /** Connection-scoped ACP client context used for requests and notifications. */
  clientContext: AgentContext;
  /** Most recent tool_call streamed, to correlate permission requests. */
  lastToolCall: { id: string; name: string } | null;
  /** Tool calls still streaming or running, keyed by tool call id. */
  toolCalls: Map<string, StreamedToolCall>;
  /** Tools the user chose "always allow" for, scoped to this session. */
  alwaysAllowed: Set<string>;
  cancelled: boolean;
  /** True only while a session/prompt handler is running. */
  promptActive: boolean;
  /** ACP session mode; enforced adapter-side in the permission callback. */
  modeId: PermissionMode;
  /** Session working directory (for project skill discovery). */
  cwd: string;
  /** Model handle reported by the runtime, updated after ACP model changes. */
  currentModel: string | undefined;
}

/** Max history messages replayed on session/load. */
const LOAD_HISTORY_LIMIT = 200;

/**
 * Liveness bound for permission requests raised outside a prompt turn.
 *
 * ACP scopes `session/request_permission` to a turn: the client's only
 * obligation to answer is the `session/cancel` contract, which no longer
 * applies once the prompt handler has returned. A client with no out-of-turn
 * permission UI would leave the Letta-side tool call pending forever, so those
 * requests get a generous-but-finite deadline. In-turn requests stay unbounded.
 */
const DEFAULT_OUT_OF_TURN_PERMISSION_TIMEOUT_MS = 300_000;

/**
 * How long to keep a turn open after the server reported completion while
 * still listing active runs. Long enough to cover the next model step, short
 * enough that a server which never speaks again cannot wedge the prompt.
 */
const DEFAULT_PREMATURE_RESULT_GRACE_MS = 30_000;

/** Safety cap on stream rounds while waiting for a slash command to finish. */
const EXECUTE_COMMAND_MAX_ROUNDS = 50;

type PumpOutcome =
  | { kind: "result"; result: SDKResultMessage }
  /** Turn reported complete while the server still listed active runs. */
  | { kind: "premature"; result: SDKResultMessage }
  | { kind: "idle" }
  | { kind: "stream_end" };

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Bridges ACP v1 (agent side) onto a Letta agent via the Letta Agent SDK.
 *
 * One process serves one ACP connection. Every ACP session becomes a new
 * Letta conversation on a single underlying Letta agent, so the agent's
 * memory persists across sessions and editors.
 */
export class LettaAcpAgent {
  private readonly config: LettaAcpConfig;
  private readonly client: LettaAgentClient;
  private readonly outOfTurnPermissionTimeoutMs: number;
  private readonly prematureResultGraceMs: number;
  private readonly sessions = new Map<string, AcpSessionState>();
  private agentIdPromise: Promise<string> | null = null;
  private clientFsCaps: EditorFsCapabilities = {
    readTextFile: false,
    writeTextFile: false,
  };

  constructor(config: LettaAcpConfig) {
    this.config = config;
    this.client = new LettaAgentClient(config.clientOptions);
    this.outOfTurnPermissionTimeoutMs =
      config.outOfTurnPermissionTimeoutMs ??
      DEFAULT_OUT_OF_TURN_PERMISSION_TIMEOUT_MS;
    this.prematureResultGraceMs =
      config.prematureResultGraceMs ?? DEFAULT_PREMATURE_RESULT_GRACE_MS;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const fs = params.clientCapabilities?.fs;
    this.clientFsCaps = {
      readTextFile: fs?.readTextFile === true,
      writeTextFile: fs?.writeTextFile === true,
    };
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === "number" && requested < PROTOCOL_VERSION
        ? requested
        : PROTOCOL_VERSION;
    return {
      protocolVersion,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: authMethodsForClient(
        params.clientCapabilities,
        this.config.clientOptions.backend === "local",
      ),
    };
  }

  async newSession(
    params: NewSessionRequest,
    cx: AgentContext,
  ): Promise<NewSessionResponse> {
    const agentId = await this.ensureAgent();
    const { sessionId, state } = await this.openSession({
      cwd: params.cwd,
      resumeId: null,
      agentId,
      clientContext: cx,
    });
    log(`session ${sessionId} -> agent ${agentId} (cwd: ${params.cwd})`);
    this.announceCommands(sessionId, cx);
    return {
      sessionId,
      modes: sessionModeState(state.modeId),
      configOptions: await this.modelConfigOptions(state),
    };
  }

  async loadSession(
    params: LoadSessionRequest,
    cx: AgentContext,
  ): Promise<LoadSessionResponse> {
    if (
      !params.sessionId.startsWith("conv-") &&
      !params.sessionId.startsWith("local-conv-")
    ) {
      throw new Error(
        `Cannot load session ${params.sessionId}: not a Letta conversation id`,
      );
    }
    const { sessionId, state } = await this.openSession({
      cwd: params.cwd,
      resumeId: params.sessionId,
      agentId: null,
      clientContext: cx,
    });
    const history = await state.session.listMessages({
      order: "desc",
      limit: LOAD_HISTORY_LIMIT,
    });
    if (history.hasMore) {
      log(
        `session ${sessionId} has more than ${LOAD_HISTORY_LIMIT} messages; replaying the most recent ${LOAD_HISTORY_LIMIT}`,
      );
    }
    const updates = historyToUpdates([...history.messages].reverse());
    for (const update of updates) {
      await cx.notify(methods.client.session.update, { sessionId, update });
    }
    log(`loaded session ${sessionId} (${updates.length} replayed updates)`);
    this.announceCommands(sessionId, cx);
    return {
      modes: sessionModeState(state.modeId),
      configOptions: await this.modelConfigOptions(state),
    };
  }

  private async modelConfigOptions(
    state: AcpSessionState,
  ): Promise<SessionConfigOption[]> {
    const { entries } = await state.session.listModels();
    const models = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
    const selected = models.find(
      (entry) =>
        entry.id === state.currentModel || entry.handle === state.currentModel,
    );
    let currentValue =
      selected?.id ??
      models.find((entry) => entry.isDefault)?.id ??
      models[0]?.id;
    const options = models.map((entry) => ({
      value: entry.id,
      name: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
    }));

    // A custom model handle may be active even when it is not in the curated
    // catalog. ACP requires currentValue to identify one of the options, so
    // retain that model rather than falsely presenting a different selection.
    if (!selected && state.currentModel) {
      currentValue = state.currentModel;
      options.unshift({ value: state.currentModel, name: state.currentModel });
    }
    if (!currentValue) return [];

    return [
      {
        id: "model",
        name: "Model",
        description: "Model used for this Letta session",
        category: "model",
        type: "select",
        currentValue,
        options,
      },
    ];
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (params.configId !== "model") {
      throw new Error(`Unknown session configuration option: ${params.configId}`);
    }
    if (typeof params.value !== "string") {
      throw new Error("The model configuration option requires a model id");
    }

    const result = await state.session.updateModel(params.value);
    state.currentModel = result.modelHandle ?? result.modelId ?? params.value;
    log(`session ${params.sessionId} model -> ${state.currentModel}`);
    return { configOptions: await this.modelConfigOptions(state) };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
    cx: AgentContext,
  ): Promise<SetSessionModeResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (!isSessionModeId(params.modeId)) {
      throw new Error(`Unknown mode: ${params.modeId}`);
    }
    state.modeId = params.modeId;
    log(`session ${params.sessionId} mode -> ${params.modeId}`);
    void cx.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      },
    });
    return {};
  }

  /**
   * Creates or resumes the underlying Letta session and registers state.
   *
   * The ACP session id is the Letta conversation id, which is what makes
   * session/load work across adapter restarts with no local persistence. The
   * id is only known after the runtime initializes, so callbacks close over a
   * mutable ref that is filled in before any of them can fire (they only run
   * during prompts).
   *
   * The harness always runs with permissionMode "standard"; the ACP-selected
   * mode is enforced adapter-side (see session-modes.ts).
   */
  private async openSession(options: {
    cwd: string;
    resumeId: string | null;
    agentId: string | null;
    clientContext: AgentContext;
  }): Promise<{ sessionId: string; state: AcpSessionState }> {
    const ref = { sessionId: options.resumeId ?? "" };
    const editorTools = createEditorTools(this.clientFsCaps, {
      getSessionId: () => ref.sessionId,
      getClientContext: () =>
        this.sessions.get(ref.sessionId)?.clientContext ?? null,
    });
    const sessionOptions = {
      cwd: options.cwd,
      model: this.config.model,
      permissionMode: "standard" as const,
      canUseTool: (
        toolName: string,
        toolInput: Record<string, unknown>,
        context?: CanUseToolContext,
      ) =>
        this.requestToolPermission(
          ref.sessionId,
          toolName,
          toolInput,
          context,
        ),
      ...(editorTools.length > 0 ? { tools: editorTools } : {}),
    };
    const session = options.resumeId
      ? this.client.resumeSession(options.resumeId, sessionOptions)
      : this.client.createSession(options.agentId ?? "", sessionOptions);
    // Force runtime initialization so the conversation id and active model exist.
    const bootstrap = await session.bootstrapState({ limit: 1 });
    const sessionId = options.resumeId ?? session.conversationId;
    if (!sessionId) {
      session.close();
      throw new Error("Letta session did not report a conversation id");
    }
    ref.sessionId = sessionId;
    if (editorTools.length > 0) {
      log(
        `editor fs tools enabled: ${editorTools.map((tool) => tool.name).join(", ")}`,
      );
    }
    const state: AcpSessionState = {
      session,
      clientContext: options.clientContext,
      lastToolCall: null,
      toolCalls: new Map(),
      alwaysAllowed: new Set(),
      cancelled: false,
      promptActive: false,
      modeId: this.config.permissionMode,
      cwd: options.cwd,
      currentModel: bootstrap.model ?? this.config.model,
    };
    this.sessions.set(sessionId, state);
    return { sessionId, state };
  }

  private announceCommands(sessionId: string, cx: AgentContext): void {
    const cwd = this.sessions.get(sessionId)?.cwd ?? process.cwd();
    const availableCommands = buildAvailableCommands(cwd);
    log(`advertising ${availableCommands.length} slash commands`);
    void cx.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    });
  }

  async prompt(
    params: PromptRequest,
    cx: AgentContext,
  ): Promise<PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    state.clientContext = cx;
    state.cancelled = false;
    state.promptActive = true;

    try {
      const commandResponse = await this.maybeRunCommand(params, state, cx);
      if (commandResponse) return commandResponse;
      await state.session.send(toLettaContent(params.prompt));
      // The Letta app-server transport completes a turn with a recoverable
      // "approval_conflict" result whenever a tool needs user approval. The
      // approval itself resolves concurrently: the server sends a
      // can_use_tool control request, our canUseTool callback forwards it to
      // the ACP client, and once answered the run resumes and its events keep
      // streaming — but with no second terminal result message. So: pump the
      // first round to its result, then pump recovery rounds (blocking on the
      // stream while approvals resolve) until the run goes idle.
      let mode: "turn" | "recovery" = "turn";
      let graceMs: number | undefined;
      while (true) {
        const outcome = await this.pumpStream(
          params.sessionId,
          state,
          cx,
          mode,
          graceMs,
        );
        if (state.cancelled) return { stopReason: "cancelled" };
        switch (outcome.kind) {
          case "premature": {
            // The SDK ends its stream on any result, so the only way to stay
            // with the run is another round — the same recovery the
            // approval_conflict path uses, but on a deadline in case the
            // server really was done.
            const runIds = outcome.result.runIds?.join(", ") ?? "unknown";
            log(`turn reported complete while runs are active (${runIds})`);
            mode = "recovery";
            graceMs = this.prematureResultGraceMs;
            continue;
          }
          case "result": {
            const result = outcome.result;
            if (!result.success && result.errorCode === "approval_conflict") {
              mode = "recovery";
              graceMs = undefined;
              continue;
            }
            return this.toPromptResponse(state, result);
          }
          case "idle":
          case "stream_end":
            return { stopReason: "end_turn" };
        }
      }
    } catch (error) {
      if (state.cancelled) return { stopReason: "cancelled" };
      throw error;
    } finally {
      // The client context stays for the lifetime of the session; only the
      // in-a-turn marker is cleared, so late tool traffic still reaches the
      // client but waits on a deadline.
      state.promptActive = false;
    }
  }

  /**
   * Handles slash commands that have a non-LLM implementation: /model runs in
   * the adapter, and execute_command-backed commands run in the harness.
   * Returns null for everything else — unknown /names fall through as prompt
   * text, which is how skill invocations reach the model.
   */
  private async maybeRunCommand(
    params: PromptRequest,
    state: AcpSessionState,
    cx: AgentContext,
  ): Promise<PromptResponse | null> {
    const first = params.prompt[0];
    if (params.prompt.length !== 1 || first?.type !== "text") return null;
    const match = first.text.trim().match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const command = (match[1] ?? "").toLowerCase();
    const argument = match[2]?.trim();

    if (isExecuteCommand(command)) {
      return this.runExecuteCommand(params.sessionId, state, cx, command, argument);
    }
    if (command !== "model") return null;

    const reply = async (text: string) => {
      await cx.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    };
    try {
      if (!argument) {
        const result = await state.session.listModels();
        const lines = result.entries.map((model) => {
          const marks = [
            model.isDefault ? "default" : null,
            model.free ? "free" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return `- \`${model.handle}\` — ${model.label}${marks ? ` (${marks})` : ""}`;
        });
        await reply(
          `Available models:\n${lines.join("\n")}\n\nSwitch with \`/model <handle>\`.`,
        );
      } else {
        const result = await state.session.updateModel(argument);
        state.currentModel = result.modelHandle ?? result.modelId ?? argument;
        await reply(`Model switched to \`${state.currentModel}\`.`);
      }
    } catch (error) {
      await reply(
        `/model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { stopReason: "end_turn" };
  }

  /**
   * Dispatches a slash command to the harness via the app-server protocol's
   * execute_command, forwarding any resulting agent-turn events (e.g. /init
   * and /remember run full turns) and finishing on the slash_command_end
   * stream delta that carries the command's output.
   */
  private async runExecuteCommand(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    command: string,
    argument: string | undefined,
  ): Promise<PromptResponse> {
    log(`executing /${command} via execute_command`);
    await state.session.sendCommand({
      type: "execute_command",
      command_id: command,
      request_id: `acp-${crypto.randomUUID()}`,
      runtime: {
        agent_id: state.session.agentId,
        conversation_id: state.session.conversationId,
      },
      ...(argument ? { args: argument } : {}),
    });

    for (let round = 0; round < EXECUTE_COMMAND_MAX_ROUNDS; round++) {
      // A cancel can land between stream rounds after a nested command turn
      // produced its terminal result. Do not attach another stream listener
      // once the command has already been aborted.
      if (state.cancelled) return { stopReason: "cancelled" };
      for await (const message of state.session.stream()) {
        if (state.cancelled) return { stopReason: "cancelled" };
        if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (
            event.message_type === "slash_command_end" &&
            event.command_id === command
          ) {
            const output = typeof event.output === "string" ? event.output : "";
            const success = event.success !== false;
            if (output) {
              await cx.notify(methods.client.session.update, {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: success ? output : `/${command} failed: ${output}`,
                  },
                },
              });
            }
            return { stopReason: "end_turn" };
          }
          continue;
        }
        if (message.type === "result") {
          // Commands like /init and /remember run a full agent turn. A
          // successful nested result, or a recoverable approval conflict,
          // ends this SDK stream round but not the command: its continuation
          // and slash_command_end arrive through a subsequent stream().
          if (
            message.success ||
            message.errorCode === "approval_conflict"
          ) {
            continue;
          }
          // Do not turn genuine nested-turn failures into 50 opaque recovery
          // rounds followed by "/<command> did not complete".
          return this.toPromptResponse(state, message);
        }
        await this.forwardMessage(sessionId, state, message, cx);
      }
    }
    throw new Error(`/${command} did not complete`);
  }

  /**
   * Iterates one session.stream() round, forwarding events to the client.
   * In "recovery" mode (post-approval continuation) there is no terminal
   * result message, so loop_status transitions decide when the turn is over.
   * Blocking on the stream while an approval is pending is fine — the
   * canUseTool round-trip resolves concurrently over the control channel.
   */
  private async pumpStream(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    mode: "turn" | "recovery",
    firstMessageDeadlineMs?: number,
  ): Promise<PumpOutcome> {
    let sawActivity = false;
    let idleStatusCount = 0;
    let activeRunIds: readonly string[] = [];

    const stream = state.session.stream()[Symbol.asyncIterator]();
    let awaitingFirstMessage = true;
    while (true) {
      const pending = stream.next();
      // Only the first message of a grace round is raced: a server that went
      // quiet after contradicting itself must not wedge the prompt.
      const step =
        awaitingFirstMessage && firstMessageDeadlineMs !== undefined
          ? await raceDeadline(pending, firstMessageDeadlineMs)
          : await pending;
      if (!step) {
        log("no further activity during the grace round; ending turn");
        return { kind: "idle" };
      }
      awaitingFirstMessage = false;
      if (step.done) break;
      const message = step.value;

      if (message.type === "result") {
        // An idle loop status that still lists active runs makes the SDK
        // synthesize a successful, stop-reason-less turn result. Taking it at
        // face value ends the prompt mid-run, stranding the tool calls that
        // are still streaming and pushing their approvals outside the turn.
        if (
          message.success &&
          message.stopReason == null &&
          activeRunIds.length > 0
        ) {
          return { kind: "premature", result: message };
        }
        return { kind: "result", result: message };
      }
      if (message.type === "loop_status") {
        activeRunIds = message.activeRunIds;
        // An abort that lands before the run produces output never gets a
        // terminal result from the SDK — the return to WAITING_ON_INPUT is
        // the only end-of-turn signal, in "turn" mode too.
        if (message.status === "WAITING_ON_INPUT" && state.cancelled) {
          return { kind: "idle" };
        }
        if (mode === "recovery") {
          if (message.status === "WAITING_ON_INPUT") {
            idleStatusCount += 1;
            // The first idle status can be stale (queued before the resume);
            // trust it once we've seen real activity or it repeats.
            if (sawActivity || idleStatusCount >= 2) {
              return { kind: "idle" };
            }
          }
          continue;
        }
      }
      const forwarded = await this.forwardMessage(
        sessionId,
        state,
        message,
        cx,
      );
      sawActivity = sawActivity || forwarded;
    }
    return { kind: "stream_end" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return;
    state.cancelled = true;
    // Interrupted tool calls never produce a tool_result, so drop their
    // accumulated arguments here instead of leaking them for the session.
    state.toolCalls.clear();
    try {
      await state.session.abort();
    } catch (error) {
      log(`abort failed for ${params.sessionId}: ${String(error)}`);
    }
  }

  shutdown(): void {
    for (const state of this.sessions.values()) {
      try {
        state.session.close();
      } catch {
        // best-effort cleanup on connection close
      }
    }
    this.sessions.clear();
  }

  /**
   * Streamed Letta SDK message -> ACP session/update notification.
   * Returns true when the message was substantive turn activity.
   */
  private async forwardMessage(
    sessionId: string,
    state: AcpSessionState,
    message: SDKMessage,
    cx: AgentContext,
  ): Promise<boolean> {
    switch (message.type) {
      case "init":
        log(`turn started (agent ${message.agentId}, model ${message.model})`);
        return false;
      case "assistant":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "reasoning":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "tool_call": {
        const existing = state.toolCalls.get(message.toolCallId);
        // Continuation deltas carry an argument fragment and often no name, so
        // the SDK reports "?" for them: the first real name wins.
        const toolName =
          knownToolName(message.toolName) ??
          existing?.toolName ??
          message.toolName;
        const input = accumulateToolInput(
          existing?.input,
          message.rawArguments,
          message.toolInput,
        );
        const diffContent = toolDiffContent(toolName, input.input);
        const hasDiff = existing?.hasDiff === true || diffContent.length > 0;
        state.toolCalls.set(message.toolCallId, { toolName, input, hasDiff });
        state.lastToolCall = { id: message.toolCallId, name: toolName };
        // Partial JSON has no usable title or locations, so hold the card
        // steady until the arguments parse rather than flickering through
        // every fragment.
        const worthSending =
          !existing ||
          (input.complete &&
            (!existing.input.complete ||
              existing.input.rawArguments !== input.rawArguments));
        if (!worthSending) return true;
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: existing ? "tool_call_update" : "tool_call",
            toolCallId: message.toolCallId,
            title: toolTitle(toolName, input.input),
            kind: toolKind(toolName),
            status: "in_progress",
            rawInput: input.input,
            locations: toolLocations(input.input),
            ...(diffContent.length > 0 ? { content: diffContent } : {}),
          },
        });
        return true;
      }
      case "tool_result": {
        const toolCall = state.toolCalls.get(message.toolCallId);
        const rawOutput = parseToolOutput(message.content);
        state.toolCalls.delete(message.toolCallId);
        const locations = toolCall
          ? toolLocations(toolCall.input.input, toolOutputLine(rawOutput))
          : [];
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: message.toolCallId,
            status: message.isError ? "failed" : "completed",
            rawOutput,
            ...(locations.length > 0 ? { locations } : {}),
            ...(toolCall?.hasDiff !== true || message.isError
              ? {
                  content: [
                    {
                      type: "content" as const,
                      content: { type: "text" as const, text: message.content },
                    },
                  ],
                }
              : {}),
          },
        });
        return true;
      }
      case "error":
        log(`stream error: ${message.message}`);
        return false;
      default:
        // queue_update, loop_status, stream_event, retry — no ACP equivalent.
        return false;
    }
  }

  private toPromptResponse(
    state: AcpSessionState,
    result: SDKResultMessage,
  ): PromptResponse {
    if (result.success) {
      return { stopReason: "end_turn" };
    }
    let stopReason: StopReason;
    switch (result.errorCode) {
      case "interrupted":
        stopReason = "cancelled";
        break;
      case "max_steps":
        stopReason = "max_turn_requests";
        break;
      default:
        if (state.cancelled) {
          stopReason = "cancelled";
          break;
        }
        throw new Error(
          result.errorDetail ?? result.error ?? "Letta turn failed",
        );
    }
    return { stopReason };
  }

  /** Letta canUseTool callback -> ACP session/request_permission. */
  private async requestToolPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    context: CanUseToolContext | undefined,
  ): Promise<CanUseToolResponse> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        behavior: "deny",
        message: "Unknown ACP session",
      };
    }
    if (state.cancelled) {
      // The client context now outlives the turn, so nothing else stops a
      // request that raced session/abort from prompting the user again after
      // they pressed stop.
      log(`denying ${toolName}: prompt turn was cancelled`);
      return {
        behavior: "deny",
        message: "Prompt turn was cancelled",
        interrupt: true,
      };
    }
    return this.resolveToolPermission(
      sessionId,
      state,
      state.clientContext,
      toolName,
      toolInput,
      context,
    );
  }

  private async resolveToolPermission(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    context: CanUseToolContext | undefined,
  ): Promise<CanUseToolResponse> {
    if (modeAutoAllows(state.modeId, toolName)) {
      log(`auto-allowing ${toolName} (mode ${state.modeId})`);
      return { behavior: "allow", updatedInput: toolInput };
    }
    log(
      `permission requested for ${toolName}` +
        (state.promptActive ? "" : " (outside a prompt turn)"),
    );
    if (state.alwaysAllowed.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // The approval carries the id of the tool call it belongs to. Without it
    // the client gets a permission card that matches no streamed tool call:
    // guessing by name attaches to the wrong card when several calls are in
    // flight, and the synthetic id orphans the card entirely.
    const toolCallId =
      context?.toolCallId ??
      (state.lastToolCall?.name === toolName
        ? state.lastToolCall.id
        : `${toolName}_${crypto.randomUUID()}`);
    const params = {
      sessionId,
      toolCall: {
        toolCallId,
        title: toolTitle(toolName, toolInput),
        kind: toolKind(toolName),
        status: "pending" as const,
        rawInput: toolInput,
        locations: toolLocations(toolInput),
      },
      options: [
        {
          optionId: "allow_once",
          name: `Allow ${toolName} once`,
          kind: "allow_once" as const,
        },
        {
          optionId: "allow_always",
          name: `Always allow ${toolName} this session`,
          kind: "allow_always" as const,
        },
        {
          optionId: "reject_once",
          name: "Reject",
          kind: "reject_once" as const,
        },
      ],
    };

    let response: RequestPermissionResponse;
    try {
      response = state.promptActive
        ? await cx.request(methods.client.session.requestPermission, params)
        : await withAcpRequestTimeout(
            (signal) =>
              cx.request(methods.client.session.requestPermission, params, {
                cancellationSignal: signal,
              }),
            {
              label: "Permission request",
              description: `approve ${toolName} outside a prompt turn`,
              timeoutMs: this.outOfTurnPermissionTimeoutMs,
            },
          );
    } catch (error) {
      log(`permission request for ${toolName} failed: ${String(error)}`);
      return {
        behavior: "deny",
        message: error instanceof Error ? error.message : String(error),
        interrupt: true,
      };
    }

    if (response.outcome.outcome === "cancelled") {
      return {
        behavior: "deny",
        message: "Prompt turn was cancelled",
        interrupt: true,
      };
    }
    switch (response.outcome.optionId) {
      case "allow_always":
        state.alwaysAllowed.add(toolName);
        return { behavior: "allow", updatedInput: toolInput };
      case "allow_once":
        return { behavior: "allow", updatedInput: toolInput };
      default:
        return { behavior: "deny", message: "User rejected this tool call" };
    }
  }

  private ensureAgent(): Promise<string> {
    if (!this.agentIdPromise) {
      this.agentIdPromise = this.resolveAgent();
      this.agentIdPromise.catch(() => {
        // Allow retry on the next session/new instead of caching the failure.
        this.agentIdPromise = null;
      });
    }
    return this.agentIdPromise;
  }

  private async resolveAgent(): Promise<string> {
    if (this.config.agentId) {
      log(`using existing agent ${this.config.agentId}`);
      return this.config.agentId;
    }
    log("creating a new Letta agent (set LETTA_AGENT_ID to reuse one)...");
    const agentId = await this.client.createAgent({
      // SDK 0.5 made personality presets opt-in. Keep the adapter's established
      // behavior instead of silently creating a zero-memory generic agent.
      personality: "memo",
      name: "ACP agent",
      description: "Letta agent driven by an ACP client (e.g. Zed)",
      model: this.config.model,
    });
    log(
      `created agent ${agentId} — set LETTA_AGENT_ID=${agentId} to keep using it`,
    );
    return agentId;
  }
}

/** Awaits `pending`, or resolves null when the deadline expires first. */
async function raceDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The SDK reports "?" when a streamed tool_call chunk omits the function name,
 * which every continuation fragment does. Treat that as "unknown" so the name
 * from the opening chunk survives.
 */
function knownToolName(toolName: string): string | undefined {
  if (!toolName || toolName === "?") return undefined;
  return toolName;
}

/** ACP prompt content blocks -> Letta multimodal message content. */
export function toLettaContent(blocks: ContentBlock[]): MessageContentItem[] {
  const content: MessageContentItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        if (IMAGE_MEDIA_TYPES.has(block.mimeType)) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
              data: block.data,
            },
          });
        }
        break;
      case "resource_link":
        content.push({ type: "text", text: `[Referenced file: ${block.uri}]` });
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          content.push({
            type: "text",
            text: `<context uri="${resource.uri}">\n${resource.text}\n</context>`,
          });
        }
        break;
      }
      default:
        // audio and future block types are not advertised in promptCapabilities
        break;
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

function log(message: string): void {
  // stdout carries the ACP JSON-RPC stream; all logging goes to stderr.
  console.error(`[letta-acp] ${message}`);
}

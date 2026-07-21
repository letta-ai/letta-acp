# letta-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for
Letta. It exposes a stateful Letta agent as an ACP agent over stdio, so any ACP
client — Zed, JetBrains, marimo, or the bundled test client — can drive it.

Built on [`@letta-ai/letta-agent-sdk`](https://github.com/letta-ai/letta-agent-sdk)
(agent/session management, streaming, tool approvals) and
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
(protocol plumbing).

## ACP v1, not v2

This adapter implements **protocol v1** (`protocolVersion: 1`):

- v1 is the current stable wire protocol. Every shipping ACP client (including
  Zed) negotiates v1 during `initialize`.
- v2 exists only as an unstable schema surface (`@agentclientprotocol/sdk`
  ships it under `experimental/v2`) that is still churning — MCP-aligned
  content types, `auth/*` regrouping, unified session lifecycle — with no
  stable release or client support yet.

When v2 stabilizes, the migration is mostly mechanical (the SDK exposes a
`dual-version-agent` example for serving both).

## Quick start

```bash
git clone git@github.com:letta-ai/letta-acp.git
cd letta-acp
bun install

# smoke test with the bundled ACP client (spawns the agent over stdio)
bun test-client.ts
bun test-client.ts "List the files in this directory using your tools."
```

The first session creates a Letta agent and logs its id to stderr; set
`LETTA_AGENT_ID` to that value to keep using the same agent (that's the point —
its memory persists across sessions and editors).

## Use from Zed

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Letta": {
      "command": "bun",
      "args": ["/path/to/letta-acp/src/index.ts"],
      "env": { "LETTA_AGENT_ID": "agent-..." }
    }
  }
}
```

Then open the Agent Panel, choose **Letta**, and start a thread.

## Backend setup

The adapter reaches Letta through one of three backends, selected with
`LETTA_ACP_BACKEND` ([self-hosting docs](https://docs.letta.com/self-hosting)):

**`local` (default) — local runtime.** The SDK spawns a private Letta Code
app-server on your machine (`letta.js --backend local app-server`); all agent
state stays on-device under `~/.letta/lc-local-backend`. Requires the
`@letta-ai/letta-code` CLI to be available (it ships as a dependency of this
package) and model access: either `letta login`, or connect providers
directly — `letta --backend local connect anthropic --api-key ...`,
`connect ollama`, etc. No env vars needed.

**`remote` — self-hosted app server.** Point the adapter at an app server you
run (`letta server --backend local --listen ws://127.0.0.1:4500`). For
non-loopback deployments enable auth
(`--ws-auth capability-token --ws-token-file <path>`):

```json
"env": {
  "LETTA_ACP_BACKEND": "remote",
  "LETTA_APP_SERVER_URL": "ws://your-host:4500",
  "LETTA_APP_SERVER_TOKEN": "<capability token, if enabled>",
  "LETTA_AGENT_ID": "agent-..."
}
```

**`cloud` — Letta Cloud.** Agents run on Letta's hosted platform; the harness
executes in a cloud sandbox. Get an API key at
[app.letta.com/api-keys](https://app.letta.com/api-keys):

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud",
  "LETTA_API_KEY": "sk-let-...",
  "LETTA_AGENT_ID": "agent-..."
}
```

Note on tool execution: with `remote` and `cloud`, built-in tools (Read, Bash,
…) run where the harness runs — the server/sandbox filesystem, not your
machine. The editor fs tools (`read_editor_buffer`, `write_via_editor`) always
operate on the editor's files regardless of backend, since they execute in the
adapter and delegate to the ACP client.

## Configuration

| Variable | Effect |
|----------|--------|
| `LETTA_ACP_BACKEND` | `local` (default, SDK-managed app-server), `remote`, or `cloud` |
| `LETTA_APP_SERVER_URL` | remote backend URL (default `ws://127.0.0.1:4500`) |
| `LETTA_APP_SERVER_TOKEN` | remote backend auth token |
| `LETTA_API_KEY` | cloud backend API key |
| `LETTA_AGENT_ID` | reuse an existing agent instead of creating one |
| `LETTA_ACP_MODEL` | model override for sessions |
| `LETTA_ACP_PERMISSION_MODE` | initial session mode: `standard` (default), `acceptEdits`, `unrestricted` — switchable live via `session/set_mode` (Zed's mode dropdown) |

## What's implemented

| ACP surface | Status |
|-------------|--------|
| `initialize` (v1 negotiation) | ✅ |
| `session/new` (per-session Letta conversation, cwd) | ✅ |
| `session/prompt` (text, image, resource, resource_link) | ✅ |
| `session/update` — message/thought chunks, tool calls, tool results | ✅ |
| `session/request_permission` (allow once / always / reject) | ✅ |
| `session/cancel` → `stopReason: cancelled` | ✅ |
| `session/load` (resume threads with history replay) | ✅ |
| Session modes (`session/set_mode`: standard / acceptEdits / unrestricted) | ✅ |
| Slash commands (`available_commands_update`: `/model`) | ✅ |
| Client fs delegation (`fs/read_text_file`, `fs/write_text_file`) | ✅ via external tools |
| Client terminal delegation (`terminal/*`) | ❌ (planned) |
| Plan updates (`plan` from TodoWrite) | ❌ (planned) |

ACP session ids are Letta conversation ids, so `session/load` works across
adapter restarts with no local state: the conversation is resumed via the SDK
and its recent history (up to 200 messages) is replayed as `session/update`
notifications. Session modes are enforced in the adapter's permission
callback — the harness always runs in `standard` mode so every approval routes
through the adapter, which is what makes live mode switching possible;
`acceptEdits` auto-allows file-edit tools, `unrestricted` auto-allows
everything. `/model` (empty to list, or a handle to switch) is handled in the
adapter without an LLM turn.

## How it works

`src/agent.ts` maps the two protocols:

- Each ACP session becomes a new conversation (`client.createSession`) on one
  underlying Letta agent, with the ACP `cwd`.
- `session/prompt` sends the message and pumps `session.stream()`, translating
  SDK messages (`assistant`, `reasoning`, `tool_call`, `tool_result`) into
  `session/update` notifications.
- Tool approvals: the SDK's `canUseTool` callback is forwarded as an ACP
  `session/request_permission` request. One Letta-specific wrinkle: the
  app-server transport ends the turn with a recoverable `approval_conflict`
  result while the approval is pending, and the resumed run streams without a
  second terminal result — so after such a result the adapter keeps pumping
  the stream (approvals resolve concurrently over the control channel) and
  ends the turn when the agent loop reports it is idle again.

## Editor file access (external tools)

The harness's built-in tools (`Read`, `Edit`, `Bash`, …) always execute
Letta-side, directly against the filesystem — the ACP client only *renders*
those tool calls. Letta's [external tools](https://docs.letta.com/platform/app-server/external-tools)
add capabilities on top (they cannot replace built-ins), and the adapter uses
them to close the editor-integration gap: when the client advertises
`clientCapabilities.fs` during `initialize`, each session registers:

- **`read_editor_buffer`** → proxies ACP `fs/read_text_file`, so the agent can
  read files *as the editor sees them*, including unsaved buffer changes that
  disk-based `Read` would miss.
- **`write_via_editor`** → proxies ACP `fs/write_text_file`, so a write lands
  in the editor's buffer with diff review and undo history instead of a raw
  disk write.

The tool descriptions steer the model to prefer these for files the user has
open and the built-ins otherwise. Both go through the normal permission flow.
Clients that don't advertise fs capabilities get no extra tools and everything
runs Letta-side as before. Terminal delegation (`terminal/*`) is the remaining
piece.

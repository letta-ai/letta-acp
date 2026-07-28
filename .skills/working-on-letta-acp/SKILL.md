---
name: working-on-letta-acp
description: Develops and tests the letta-ai/letta-acp adapter. Use when changing ACP protocol handling, Letta Agent SDK integration, sessions, streaming, tool calls, approvals, cancellation, editor filesystem delegation, slash commands, backends, acpx compatibility, packaging, or CI in this repository.
---

# Working on letta-acp

Treat this repository as a protocol adapter with three independently meaningful boundaries:

1. ACP clients speak JSON-RPC over stdio to `src/index.ts`.
2. `src/agent.ts` translates ACP sessions and updates to the Letta Agent SDK.
3. The SDK reaches a local, remote, Cloud, or Cloud-OAuth Letta runtime.

Prove the boundary affected by the change instead of relying only on unit-level mocks.

## Start with the owning code

- `src/index.ts`: stdio transport and ACP method registration.
- `src/agent.ts`: sessions, prompts, streaming, approvals, cancellation, and lifecycle state.
- `src/config.ts`: environment variables and backend selection.
- `src/editor-tools.ts`: ACP client filesystem delegation.
- `src/history-replay.ts`: `session/load` transcript replay.
- `src/session-modes.ts`: adapter-enforced permission modes.
- `src/slash-commands.ts`: advertised and executed slash commands.
- `src/tool-info.ts`: streamed tool-input accumulation, titles, kinds, and locations.
- `test/agent-integration.test.ts`: deterministic SDK/app-server lifecycle coverage.
- `test/acpx-client.test.ts`: real `acpx` client plus real adapter stdio entrypoint against a fake app server.
- `test/acpx-live.ts`: credentialed `acpx` → adapter → Letta Cloud session check.

Read the relevant implementation and adjacent tests before editing. For lifecycle work, trace the full event order across both ACP and SDK messages; do not infer correctness from one terminal result.

## Choose the right test boundary

### Pure mapping or formatting

Add focused Bun tests beside the owning module. Include fragmented, malformed, duplicate, and ordinary inputs when the code consumes streamed data.

### SDK/app-server lifecycle

Extend `test/agent-integration.test.ts` and its `FakeAppServer`. Exercise realistic control and stream events, including:

- tool-call fragments followed by results;
- permission requests correlated by `tool_call_id`;
- approval continuation rounds;
- `WAITING_ON_INPUT` with and without `active_run_ids`;
- cancellation while work or permission requests remain pending;
- delayed, duplicate, and missing terminal events.

Assert both the returned ACP `stopReason` and the ordered `session/update` lifecycle. A green direct-method test does not prove stdio client compatibility.

### ACP client compatibility

Run:

```bash
bun run test:acpx
```

This invokes the pinned published `acpx` client against `src/index.ts`, using a deterministic fake app server. Extend `test/acpx-client.test.ts` when changing initialization, session creation, prompts, update schemas, permissions, tool cards, cancellation, or output that a real ACP client consumes.

Do not replace this with the bundled `test-client.ts`; that client shares this repository's assumptions and is primarily a manual debugging surface.

### Live Cloud transport

Run:

```bash
LETTA_API_KEY=... \
LETTA_ACP_TEST_AGENT_ID=agent-... \
bun run test:acpx:live
```

The live check authenticates through the Cloud backend and creates a real conversation through `acpx`. It intentionally avoids a model turn so routine CI does not depend on credits, provider limits, or model output.

When explicitly validating a full model turn, use the dedicated `letta-acp-ci` agent, keep it on `letta/auto-fast`, use `--deny-all`, request an exact sentinel response, and set a finite timeout. Do not turn that model-dependent probe into required PR CI unless its funding and rate-limit ownership are stable.

## Credential and CI rules

- Never print API keys or OAuth tokens. Inspect only presence, prefix, or length when debugging credentials.
- Store `LETTA_API_KEY` as an Actions secret and the non-secret agent ID as `LETTA_ACP_TEST_AGENT_ID` repository variable.
- Never expose repository secrets to pull requests or fork-controlled code. Keep credentialed tests on trusted pushes; PRs must remain fully covered by deterministic tests.
- Use a dedicated CI agent, not a developer's personal agent. Avoid persistent prompts or tool side effects in live checks.
- Pin `acpx` to an exact version so client behavior changes arrive as reviewable dependency updates.

## Validate changes

Run the narrowest useful test while iterating, then before review run:

```bash
bun run check
```

For changes affecting the external client boundary, also run `bun run test:acpx` explicitly. For Cloud/backend/auth changes, run `bun run test:acpx:live` with the dedicated agent.

When changing packaging or the bin entrypoint, preserve the CI consumer-pack test: it installs the generated tarball and negotiates ACP `initialize` through `node_modules/.bin/letta-acp`.

## Review before publishing

Check the actual diff for:

- a regression test that reaches the reported failure boundary;
- sibling lifecycle states, retries, cancellation, and old sessions;
- no secret-bearing logs or fixtures;
- no dependence on model wording in deterministic CI;
- comments explaining non-obvious event-order or liveness logic;
- README claims that match what CI really proves.

Do not claim the ACP flow is solved when only a direct adapter method passed. State whether validation covered a unit, fake app server, real ACP client, live Cloud session, or live model turn.

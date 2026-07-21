import type { SessionModeState } from "@agentclientprotocol/sdk";
import type { PermissionMode } from "@letta-ai/letta-agent-sdk";

/**
 * ACP session modes exposed to clients (Zed renders these as a dropdown).
 *
 * The Letta harness always runs with permissionMode "standard" so every
 * approval routes through the adapter's canUseTool callback; the adapter then
 * enforces the ACP-selected mode itself, which is what makes live mode
 * switching (session/set_mode) possible mid-session.
 */
export const SESSION_MODE_IDS: PermissionMode[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

/** Tools auto-allowed in acceptEdits mode. */
const EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "write_via_editor",
]);

export function isSessionModeId(value: string): value is PermissionMode {
  return (SESSION_MODE_IDS as string[]).includes(value);
}

export function sessionModeState(currentModeId: PermissionMode): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      {
        id: "standard",
        name: "Ask before edits",
        description: "Request permission for file edits and shell commands",
      },
      {
        id: "acceptEdits",
        name: "Accept edits",
        description: "Auto-allow file edits; still ask for shell commands",
      },
      {
        id: "unrestricted",
        name: "Bypass permissions",
        description: "Auto-allow all tool calls without asking",
      },
    ],
  };
}

/** Whether the adapter should auto-allow this tool under the given mode. */
export function modeAutoAllows(mode: PermissionMode, toolName: string): boolean {
  if (mode === "unrestricted") return true;
  if (mode === "acceptEdits") return EDIT_TOOLS.has(toolName);
  return false;
}

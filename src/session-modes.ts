import type {
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type { PermissionMode } from "@letta-ai/letta-agent-sdk";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

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

export const PERMISSION_MODE_CONFIG_ID = "permissions";

const SESSION_MODES = [
  {
    id: "standard",
    name: "Ask before edits",
    description:
      "Allow workspace reads; ask before edits, shell commands, and outside-workspace reads",
  },
  {
    id: "acceptEdits",
    name: "Accept edits",
    description:
      "Allow workspace reads and file edits; ask before shell commands and outside-workspace reads",
  },
  {
    id: "unrestricted",
    name: "Bypass permissions",
    description: "Auto-allow all tool calls without asking",
  },
] as const;

/**
 * Session bookkeeping does not read files, edit the workspace, or execute
 * commands. Match the Letta harness, which marks these tools as not requiring
 * approval, so progress tracking never interrupts an otherwise safe turn.
 */
const BOOKKEEPING_TOOLS = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
]);

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
    availableModes: SESSION_MODES.map((mode) => ({ ...mode })),
  };
}

/**
 * Modern ACP clients render session modes from category=mode config options.
 * Keep the legacy `modes` response too for clients that still use
 * `session/set_mode`.
 */
export function permissionModeConfigOption(
  currentModeId: PermissionMode,
): SessionConfigOption {
  return {
    id: PERMISSION_MODE_CONFIG_ID,
    name: "Permissions",
    description: "Approval behavior for tool calls",
    category: "mode",
    type: "select",
    currentValue: currentModeId,
    options: SESSION_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  };
}

/** Whether the adapter should auto-allow this tool under the given mode. */
export function modeAutoAllows(mode: PermissionMode, toolName: string): boolean {
  if (mode === "unrestricted") return true;
  if (BOOKKEEPING_TOOLS.has(toolName)) return true;
  if (mode === "acceptEdits") return EDIT_TOOLS.has(toolName);
  return false;
}

/**
 * Editor reads match the harness's read-only tool behavior only inside the
 * active workspace. Canonicalize both paths before comparing so `..`, sibling
 * prefixes, and symlinks cannot turn an apparently local read into an
 * automatic approval. New unsaved files inherit their nearest existing
 * ancestor; malformed or otherwise unresolvable targets stay controlled.
 */
export async function editorReadAutoAllows(
  mode: PermissionMode,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<boolean> {
  if (toolName !== "read_editor_buffer") return false;
  if (mode === "unrestricted") return true;

  const requestedPath = toolInput.path;
  if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) {
    return false;
  }

  try {
    const [workspace, target] = await Promise.all([
      realpath(resolve(cwd)),
      canonicalBoundaryPath(requestedPath),
    ]);
    const fromWorkspace = relative(workspace, target);
    return (
      fromWorkspace === "" ||
      (fromWorkspace !== ".." &&
        !fromWorkspace.startsWith(`..${sep}`) &&
        !isAbsolute(fromWorkspace))
    );
  } catch {
    return false;
  }
}

/** Resolve symlinks while still supporting a new unsaved editor buffer. */
async function canonicalBoundaryPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      // `realpath` also reports ENOENT for a dangling symlink. Do not treat
      // that as a new in-workspace buffer: its eventual target is unconstrained.
      let cursorIsMissing = false;
      try {
        await lstat(cursor);
      } catch (statError) {
        if (
          statError &&
          typeof statError === "object" &&
          (statError as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          cursorIsMissing = true;
        } else {
          throw statError;
        }
      }
      if (!cursorIsMissing) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Cannot resolve ${path}`);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

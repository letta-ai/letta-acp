import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";
import type {
  LettaCodeClientOptions,
  PermissionMode,
} from "@letta-ai/letta-agent-sdk";

export interface LettaAcpConfig {
  /** Letta backend client options (local | remote | cloud | cloud-oauth). */
  clientOptions: LettaCodeClientOptions;
  /** Reuse an existing agent instead of creating one on first session. */
  agentId?: string;
  /** Model override for sessions (e.g. "anthropic/claude-sonnet-4"). */
  model?: string;
  /** Letta permission mode; tool approvals are forwarded to the ACP client. */
  permissionMode: PermissionMode;
  /** Directory for controller-owned ACP session metadata; null keeps it in memory. */
  sessionRegistryDir?: string | null;
  /** Separates records belonging to different Letta backends. */
  sessionRegistryScope?: string;
  /**
   * Deadline for permission requests raised outside a prompt turn, where the
   * ACP client has no obligation to answer. Defaults to five minutes.
   */
  outOfTurnPermissionTimeoutMs?: number;
  /**
   * How long a turn stays open after the server reports completion while still
   * listing active runs. Defaults to 30 seconds.
   */
  prematureResultGraceMs?: number;
}

const PERMISSION_MODES: PermissionMode[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

const BACKENDS = ["local", "remote", "cloud", "cloud-oauth"] as const;

/** Remote app-server URL, or undefined when unset or blank. */
function remoteUrlOf(
  env: Record<string, string | undefined>,
): string | undefined {
  const url = env.LETTA_APP_SERVER_URL;
  return url && url.trim().length > 0 ? url : undefined;
}

/**
 * Backend to use when `LETTA_ACP_BACKEND` is not set.
 *
 * The environment already says where the agent should live, so requiring a
 * second variable to repeat it is a step users forget — and the failure is
 * indirect: the adapter starts, opens a session, then dies mid-turn on a
 * credential the chosen backend never needed.
 *
 * An app-server URL names one specific server, so it wins over an API key that
 * may have been exported for unrelated tooling; neither means everything runs
 * here. Set `LETTA_ACP_BACKEND` to override.
 *
 * An API key means the agent lives on Letta Cloud; tools still execute here.
 */
function inferBackend(env: Record<string, string | undefined>): string {
  if (remoteUrlOf(env)) return "remote";
  if (env.LETTA_API_KEY) return "cloud";
  return "local";
}

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): LettaAcpConfig {
  const explicitBackend = env.LETTA_ACP_BACKEND;
  const backend = explicitBackend ?? inferBackend(env);
  if (!explicitBackend) {
    log(`backend inferred from the environment: ${backend}`);
  }

  let clientOptions: LettaCodeClientOptions;
  let sessionRegistryScope = backend;
  switch (backend) {
    case "local":
      clientOptions = { backend: "local" };
      break;
    case "remote": {
      const url = remoteUrlOf(env) ?? "ws://127.0.0.1:4500";
      clientOptions = {
        backend: "remote",
        url,
        authToken: env.LETTA_APP_SERVER_TOKEN,
      };
      sessionRegistryScope = `remote:${url}`;
      break;
    }
    // `cloud` and `cloud-oauth` are the same backend: the agent lives on Letta
    // Cloud and tools execute here.
    //
    // The SDK also offers a sandboxed cloud mode, where tool calls run in a
    // Letta-managed container. This adapter deliberately does not expose it. An
    // ACP client hands the agent a `cwd`, filesystem tools, and terminals that
    // exist only on the client's machine, so an agent that cannot reach them is
    // broken in a way that surfaces late and confusingly: sessions open, model
    // catalogs list, and the agent then reports missing files and missing CLIs
    // for a project it was never able to see.
    //
    // Credentials resolve the way the letta-code CLI resolves them — OS
    // keychain tokens from `letta login`, refreshed automatically, falling back
    // to LETTA_API_KEY when present — so either form of auth works here.
    case "cloud":
    case "cloud-oauth":
      sessionRegistryScope = "cloud";
      clientOptions = {
        backend: "local",
        appServer: { harnessBackend: "api" },
      };
      break;
    default:
      throw new Error(
        `Unknown LETTA_ACP_BACKEND "${backend}" (expected ${BACKENDS.join(" | ")})`,
      );
  }

  const permissionMode = env.LETTA_ACP_PERMISSION_MODE ?? "standard";
  if (!PERMISSION_MODES.includes(permissionMode as PermissionMode)) {
    throw new Error(
      `Unknown LETTA_ACP_PERMISSION_MODE "${permissionMode}" (expected ${PERMISSION_MODES.join(" | ")})`,
    );
  }

  return {
    clientOptions,
    agentId: env.LETTA_AGENT_ID,
    model: env.LETTA_ACP_MODEL,
    permissionMode: permissionMode as PermissionMode,
    sessionRegistryDir:
      env.LETTA_ACP_STATE_DIR ?? join(homedir(), ".letta", "letta-acp", "sessions"),
    sessionRegistryScope,
  };
}

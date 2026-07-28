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
  /**
   * Deadline for permission requests raised outside a prompt turn, where the
   * ACP client has no obligation to answer. Defaults to five minutes.
   */
  outOfTurnPermissionTimeoutMs?: number;
}

const PERMISSION_MODES: PermissionMode[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

const BACKENDS = ["local", "remote", "cloud", "cloud-oauth"] as const;

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): LettaAcpConfig {
  const backend = env.LETTA_ACP_BACKEND ?? "local";

  let clientOptions: LettaCodeClientOptions;
  switch (backend) {
    case "local":
      clientOptions = { backend: "local" };
      break;
    case "remote":
      clientOptions = {
        backend: "remote",
        url: env.LETTA_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
        authToken: env.LETTA_APP_SERVER_TOKEN,
      };
      break;
    case "cloud": {
      const apiKey = env.LETTA_API_KEY;
      if (!apiKey) {
        throw new Error(
          "LETTA_ACP_BACKEND=cloud requires LETTA_API_KEY. " +
            'To use your existing `letta login` session instead, set LETTA_ACP_BACKEND="cloud-oauth".',
        );
      }
      clientOptions = { backend: "cloud", apiKey };
      break;
    }
    case "cloud-oauth":
      // Cloud agents authenticated through the letta-code harness rather than
      // an explicit API key: the SDK spawns a local app-server pointed at
      // Letta Cloud, and that harness resolves credentials the same way the
      // CLI does (OS keychain tokens from `letta login`, with automatic
      // refresh, falling back to LETTA_API_KEY when present). Tools still
      // execute on this machine.
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
  };
}

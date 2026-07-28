import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AuthMethod,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";

const TERMINAL_AUTH_META_KEY = "terminal-auth";

/** Return the out-of-band login flow only when the ACP client can launch it. */
export function authMethodsForClient(
  capabilities: ClientCapabilities | undefined,
  supportsLettaLogin: boolean,
): AuthMethod[] {
  const legacyTerminalCapability =
    capabilities?._meta?.[TERMINAL_AUTH_META_KEY] === true;
  if (
    !supportsLettaLogin ||
    (capabilities?.auth?.terminal !== true && !legacyTerminalCapability)
  ) {
    return [];
  }

  return [
    {
      id: "letta-login",
      name: "Log in to Letta",
      description: "Authenticate with Letta in an interactive terminal",
      type: "terminal",
      args: ["--login"],
    },
  ];
}

/** Run the Letta CLI's existing interactive login flow for terminal auth. */
export async function runTerminalLogin(
  cliPath = fileURLToPath(import.meta.resolve("@letta-ai/letta-code")),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "login"], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Letta login terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

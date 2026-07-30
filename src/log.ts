/**
 * Adapter logging.
 *
 * stdout carries the ACP JSON-RPC stream, so every diagnostic goes to stderr —
 * a stray stdout write corrupts the protocol framing and the client drops the
 * connection.
 */
export function log(message: string): void {
  console.error(`[letta-acp] ${message}`);
}

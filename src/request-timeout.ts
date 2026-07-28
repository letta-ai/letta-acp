/**
 * Liveness bound for outbound ACP requests.
 *
 * ACP cancellation is cooperative: a client that never answers a request would
 * otherwise pin the Letta-side call forever. The local timer is what guarantees
 * the caller gets control back, and the abort is a best-effort hint to a client
 * that is still listening.
 */
export async function withAcpRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: { label: string; description: string; timeoutMs: number },
): Promise<T> {
  const { label, description, timeoutMs } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label} timed out after ${timeoutMs}ms while trying to ${description}`,
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

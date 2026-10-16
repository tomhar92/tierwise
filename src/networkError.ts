// A failed fetch carries the reason in `cause`, and the router used to print the
// whole stack for it. A dropped connection is common and the operator's fix is
// to check the network, so the log gets one line and the client gets an error
// in the shape it already knows how to show.

const REASONS: Record<string, string> = {
  ENOTFOUND: "DNS lookup failed",
  EAI_AGAIN: "DNS lookup failed",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  ENETUNREACH: "network unreachable",
  EHOSTUNREACH: "host unreachable",
};

/** A readable description when `err` is a failure to reach the upstream,
 * otherwise undefined (a real router bug should keep its stack trace). */
export function describeNetworkError(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown; hostname?: unknown; address?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (!code || !(code in REASONS)) return undefined;
  const target = typeof cause?.hostname === "string" ? cause.hostname : typeof cause?.address === "string" ? cause.address : "the upstream";
  return `could not reach ${target}: ${REASONS[code]} (${code})`;
}

/** The body Anthropic itself returns for a server-side failure, so Claude Code
 * shows the message and retries instead of choking on an unfamiliar shape. */
export function anthropicErrorBody(message: string): string {
  return JSON.stringify({ type: "error", error: { type: "api_error", message: `tierwise: ${message}` } });
}

/** Logs a repeating failure once, then once more when it clears. */
export class OutageLog {
  private failing = false;

  /** True for the first failure of a streak, which is the one worth logging. */
  failed(): boolean {
    const first = !this.failing;
    this.failing = true;
    return first;
  }

  /** True when this success ends a streak that was logged. */
  succeeded(): boolean {
    const recovered = this.failing;
    this.failing = false;
    return recovered;
  }
}

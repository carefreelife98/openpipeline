/**
 * The langchain MCP adapter wraps McpError into ToolException WITHOUT `cause`,
 * so instanceof/code checks never match (Mate-X H2). The reliable signal is the
 * standard message prefix `MCP error <code>:` — parse the code from it.
 */
const RETRYABLE_CODES = new Set([-32000 /* ConnectionClosed */, -32001 /* RequestTimeout */]);

export function parseMcpErrorCode(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /MCP error (-?\d+):/.exec(msg);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

export function isRetryableMcpTransportError(err: unknown): boolean {
  const code = parseMcpErrorCode(err);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

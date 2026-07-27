import type { PipelineEvent } from '@openpipeline/core';

/**
 * Format a single SSE frame: `event: <kind>\ndata: <json>\n\n`.
 *
 * Guards `JSON.stringify` (#E3): a node's `output` is `unknown` and can carry
 * a circular reference or a BigInt straight from a TOOL handler, before any
 * `safeJson` pass runs on the persistence path. Throwing here would tear down
 * the whole SSE response mid-stream over a single bad frame. Instead we
 * degrade to a minimal frame that still names the event kind and explicitly
 * signals the failure — never a silently dropped frame.
 */
export function sseFrame(event: PipelineEvent): string {
  let data: string;
  try {
    data = JSON.stringify(event);
  } catch {
    data = JSON.stringify({ kind: event.kind, error: 'payload_not_serializable' });
  }
  return `event: ${event.kind}\ndata: ${data}\n\n`;
}

/** Standard SSE response headers. */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

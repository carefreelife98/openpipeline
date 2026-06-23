import type { PipelineEvent } from '@openpipeline/core';

/** Minimal shape of a LangGraph streamEvents v2 event. */
export interface LangGraphStreamEvent {
  event: string;
  name?: string;
  metadata?: { langgraph_node?: string };
  data?: unknown;
}

/**
 * Translate a LangGraph streamEvents v2 event into a PipelineEvent. Faithful port
 * of the Mate-X translator.
 *
 * `knownNodeIds` filters out nested sub-graph node events: some node handlers run
 * their own LangGraph internally, whose nodes also carry `langgraph_node`
 * metadata. Pass the top-level graph's node id set to ignore those.
 */
export function translateEvent(
  event: LangGraphStreamEvent,
  knownNodeIds?: ReadonlySet<string>
): PipelineEvent | null {
  switch (event.event) {
    case 'on_chain_start': {
      const nodeId = event.metadata?.langgraph_node;
      if (!nodeId || (knownNodeIds && !knownNodeIds.has(nodeId))) return null;
      return { kind: 'NODE_START', nodeId };
    }
    case 'on_chain_end': {
      const nodeId = event.metadata?.langgraph_node;
      if (!nodeId || (knownNodeIds && !knownNodeIds.has(nodeId))) return null;
      const partial = (
        event.data as
          | {
              output?: {
                outputs?: Record<string, unknown>;
                nodeMeta?: Record<string, { startedAt?: string; finishedAt?: string }>;
              };
            }
          | undefined
      )?.output;
      const output = partial?.outputs?.[nodeId];
      const meta = partial?.nodeMeta?.[nodeId];
      return {
        kind: 'NODE_END',
        nodeId,
        output,
        startedAt: meta?.startedAt,
        finishedAt: meta?.finishedAt,
      };
    }
    case 'on_chat_model_stream': {
      const chunk = (event.data as { chunk?: { content?: string } } | undefined)?.chunk;
      const text = typeof chunk?.content === 'string' ? chunk.content : '';
      if (!text) return null;
      return { kind: 'LLM_CHUNK', text };
    }
    default:
      return null;
  }
}

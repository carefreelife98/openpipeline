import type { NodeSpec } from '@openpipeline/core';
import { z } from 'zod';

export const DESIGN_SYSTEM_PROMPT =
  'You are a pipeline planner for OpenPipeline. Given a user instruction and a catalog of ' +
  'available node specs, produce a directed acyclic graph of nodes and edges that fulfills the ' +
  'instruction.\n\n' +
  'Rules:\n' +
  '- Use short ids of your own choosing for nodes (e.g. "n1", "n2"), unique within your draft. ' +
  'These are NOT persisted ids; the planner assigns real ids separately.\n' +
  '- Every node\'s "key" must be copied EXACTLY from the catalog below — never invent a key.\n' +
  '- Bind every required input slot (see each spec\'s inputSchema "required" list): use ' +
  '{"kind":"literal","value":...} for a constant you choose, {"kind":"state","path":"outputs.<nodeId>.<field>"} ' +
  "to read another node's output (the referenced node id must be one of YOUR short ids, and that " +
  'node must be an ancestor of this one), or {"kind":"auto"} to leave it for runtime resolution.\n' +
  '- A node whose spec has `nodeType: "IF"` MUST have exactly one outgoing edge labeled "true" and ' +
  'exactly one outgoing edge labeled "false". No other node should use edge labels.\n' +
  '- The graph must have no cycles, and every node must be reachable from an entry node (a node ' +
  'with no incoming edges) or otherwise connected to the rest of the graph.\n' +
  '- Return a complete draft every time, not a diff — even when correcting a previous attempt.';

export interface SpecCatalogResult {
  /** One block per spec that could be JSON-Schema-converted, joined for the prompt. */
  text: string;
  /** One entry per spec that could NOT be converted and was excluded (D2 fail-soft). */
  warnings: string[];
}

/**
 * Renders every spec's key/displayName/description plus its input and output
 * JSON Schema (zod v4's native `z.toJSONSchema`, per D3) for embedding in the
 * design prompt. A spec whose schema cannot be converted (an exotic zod type
 * `toJSONSchema` refuses by default) is excluded from the prompt rather than
 * aborting the whole design — surfaced as an explicit `plannerWarnings` entry
 * (no silent drop), matching the same fail-soft-per-item philosophy D2
 * prescribes for per-key MCP spec resolution.
 */
export function buildSpecCatalogText(specs: readonly NodeSpec[]): SpecCatalogResult {
  const blocks: string[] = [];
  const warnings: string[] = [];

  for (const spec of specs) {
    try {
      const inputSchema = z.toJSONSchema(spec.inputSchema);
      const outputSchema = z.toJSONSchema(spec.outputSchema);
      blocks.push(
        [
          `- key: ${JSON.stringify(spec.key)}`,
          `  nodeType: ${JSON.stringify(spec.nodeType)}`,
          `  displayName: ${JSON.stringify(spec.displayName)}`,
          `  description: ${JSON.stringify(spec.description)}`,
          `  inputSchema: ${JSON.stringify(inputSchema)}`,
          `  outputSchema: ${JSON.stringify(outputSchema)}`,
        ].join('\n')
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `[design] spec "${spec.key}" input/output schema could not be converted to JSON Schema ` +
          `(${reason}); excluded from the design prompt.`
      );
    }
  }

  return { text: blocks.join('\n'), warnings };
}

export interface DesignPromptParams {
  instruction: string;
  catalogText: string;
  /** Short-id-rewritten feedback from a previous failed attempt, if any. */
  feedback?: string;
}

export function buildDesignPrompt(params: DesignPromptParams): string {
  const sections = [
    `User instruction:\n${params.instruction}`,
    `\nAvailable node specs:\n${params.catalogText || '(none)'}`,
  ];
  if (params.feedback) {
    sections.push(
      `\nThe previous attempt failed validation. Return a corrected, COMPLETE draft (not a diff) ` +
        `that fixes every issue below:\n${params.feedback}`
    );
  }
  return sections.join('\n');
}

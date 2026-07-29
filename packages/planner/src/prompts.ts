import type { NodeSpec, ResolvedProvider } from '@openpipeline/core';
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

// ── T2: MCP-catalog path (D2's `intent` and `select` nodes) ─────────────────

export const INTENT_SYSTEM_PROMPT =
  'You are the intent-classification step of a pipeline planner for OpenPipeline. Given a user ' +
  "instruction, summarize the user's task in one sentence and decide whether fulfilling it " +
  'requires calling an external MCP (Model Context Protocol) tool beyond the built-in node ' +
  'specs this planner already has. If you can name specific MCP providers that sound relevant ' +
  'from the instruction alone, list their keys as a hint for the next step.';

export interface IntentPromptParams {
  instruction: string;
}

export function buildIntentPrompt(params: IntentPromptParams): string {
  return [
    `User instruction:\n${params.instruction}`,
    '\nDecide whether this instruction needs an external MCP tool (e.g. web search, a specific ' +
      'third-party API or integration) that goes beyond a generic built-in capability. If unsure, ' +
      'prefer needsMcp: true so the next step can offer you a tool catalog to pick from.',
  ].join('\n');
}

export const SELECT_SYSTEM_PROMPT =
  'You are the MCP tool-selection step of a pipeline planner for OpenPipeline. Given a user ' +
  'instruction and a catalog of available MCP provider tools, pick only the tools actually ' +
  'needed to fulfill the instruction — an empty selection is correct when none of them apply.';

/** How many characters of a tool's description are shown in the select prompt (D2). */
const SELECT_DESCRIPTION_TRUNCATE_LENGTH = 240;

/**
 * Renders every provider/tool in a loaded MCP catalog as `mcp:<provider>:<tool>`
 * key + truncated description, for embedding in the select prompt (D2: "prompt
 * lists provider/tool keys + descriptions truncated 240 chars"). A tool with
 * no description renders an empty one rather than being skipped — `select`
 * still needs to see the key exists.
 */
export function buildMcpCatalogText(providers: readonly ResolvedProvider[]): string {
  const blocks: string[] = [];
  for (const provider of providers) {
    for (const tool of provider.tools) {
      const description = (tool.description ?? '').slice(0, SELECT_DESCRIPTION_TRUNCATE_LENGTH);
      blocks.push(
        [
          `- key: ${JSON.stringify(`mcp:${provider.key}:${tool.name}`)}`,
          `  provider: ${JSON.stringify(provider.displayName)}`,
          `  description: ${JSON.stringify(description)}`,
        ].join('\n')
      );
    }
  }
  return blocks.join('\n');
}

/**
 * D2b re-entry context (T3 review llm-robustness #2): populated only when
 * this `select` call is a `correct`-routed re-entry — an earlier round's
 * draft referenced an `mcp:` key that never resolved to a spec, so `correct`
 * routed back to `select` instead of `design` for "another chance to pick a
 * different tool" (see `correct.node.ts`). Without this, `buildSelectPrompt`
 * produces the exact same prompt on every re-entry (byte-identical to the
 * first call whenever `instruction`/`taskSummary`/`catalogText` are all
 * unchanged, which they always are here — a temperature-only re-roll, not an
 * actual second chance).
 */
export interface SelectReentryContext {
  /** Key(s) the previous draft referenced but that never resolved to a spec — must be dropped or replaced. */
  unresolvedKeys: readonly string[];
  /** Key(s) already resolved by an earlier round this `plan()` call — still available, no need to re-select. */
  resolvedKeys: readonly string[];
}

export interface SelectPromptParams {
  instruction: string;
  taskSummary?: string;
  catalogText: string;
  /** Omit for `select`'s first call this `plan()`; see {@link SelectReentryContext}. */
  reentry?: SelectReentryContext;
}

export function buildSelectPrompt(params: SelectPromptParams): string {
  const sections = [`User instruction:\n${params.instruction}`];
  if (params.taskSummary) sections.push(`\nTask summary:\n${params.taskSummary}`);
  if (params.reentry) {
    const { unresolvedKeys, resolvedKeys } = params.reentry;
    const reentryLines = [
      '\nThis is a correction: the previous draft referenced one or more MCP tool keys that were ' +
        'never actually selected and resolved, so validation failed.',
    ];
    if (unresolvedKeys.length > 0) {
      reentryLines.push(
        `- These key(s) do NOT resolve to a real tool — do not reference them again: ` +
          unresolvedKeys.join(', ')
      );
    }
    if (resolvedKeys.length > 0) {
      reentryLines.push(
        `- These key(s) are already resolved and available to the design step without ` +
          `re-selecting them: ${resolvedKeys.join(', ')}`
      );
    }
    reentryLines.push(
      'Pick the correct key(s) from the catalog below, copied EXACTLY, or return an empty array ' +
        'if none of them are actually needed.'
    );
    sections.push(reentryLines.join('\n'));
  }
  sections.push(`\nAvailable MCP tools:\n${params.catalogText || '(none)'}`);
  sections.push(
    '\nReturn the "mcp:<provider>:<tool>" keys you need, copied EXACTLY from the catalog above. ' +
      'Return an empty array if none of them are needed.'
  );
  return sections.join('\n');
}

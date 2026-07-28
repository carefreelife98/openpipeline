import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  NodeInputs,
  NodeSpec,
  PipelineDraft,
  PipelineEdgeRow,
  PipelineNodeRow,
} from '@openpipeline/core';

import { checkAbort } from '../abort.js';
import { applyAutoFill } from '../auto-fill.js';
import { buildIdAssignment, type IdAssignment } from '../id-map.js';
import { computeLayeredPositions } from '../layout.js';
import { buildDesignPrompt, buildSpecCatalogText, DESIGN_SYSTEM_PROMPT } from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import { PlannerDraftSchema, type PlannerDraft, type PlannerDraftNode } from '../schema.js';
import type { PlannerState } from '../state.js';
import { asStructuredOutputModel } from '../structured-output.js';

const MAX_NAME_LENGTH = 80;

function derivePipelineName(instruction: string): string {
  const trimmed = instruction.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * Rewrites a `state`-binding path's leading `outputs.<shortId>` segment to
 * `outputs.<uuid>`, using the same node-id-extraction pattern
 * `@openpipeline/nodes`'s graph-validator.ts uses for `REF_SOURCE_MISSING` /
 * `REF_NOT_PREDECESSOR` detection, so the rewritten path is exactly what that
 * validator will look for. Paths outside the `outputs.*` shape (e.g.
 * `meta.*`, `input.*`) are left untouched. Any short id encountered here that
 * wasn't already resolved (referenced only inside a binding path, never as a
 * node/edge id) still gets a stable uuid via `idAssignment.resolve` — kept
 * reversible for feedback even though it will fail `REF_SOURCE_MISSING`.
 */
function rewriteStatePath(path: string, idAssignment: IdAssignment): string {
  const match = /^outputs\.([^.[]+)(.*)$/.exec(path);
  if (!match) return path;
  const [, shortId, rest] = match;
  return `outputs.${idAssignment.resolve(shortId as string)}${rest as string}`;
}

function remapInputs(inputs: PlannerDraftNode['inputs'], idAssignment: IdAssignment): NodeInputs {
  const remapped: NodeInputs = {};
  for (const [slot, binding] of Object.entries(inputs)) {
    remapped[slot] =
      binding.kind === 'state'
        ? { kind: 'state', path: rewriteStatePath(binding.path, idAssignment) }
        : binding;
  }
  return remapped;
}

/**
 * D2's design node: resolve specs, build the catalog-embedding prompt
 * (feeding back the previous attempt's short-id-rewritten errors when this is
 * a correction round), get a structured `PlannerDraft` from the LLM (D3),
 * remap its short ids to stable UUIDs (D4), apply deterministic auto-fill
 * (D5), compute advisory layered positions (D6), and produce the
 * `@openpipeline/core` `PipelineDraft` the rest of the loop validates.
 */
export async function designNode(
  state: PlannerState,
  runtime: PlannerRuntime
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  runtime.onProgress?.({
    phase: 'design',
    attempt: state.attempts,
    detail: state.designFeedback ? 'revising draft after validation feedback' : 'generating draft',
  });

  const specsByKey = new Map(runtime.specs.map((spec) => [spec.key, spec] as const));
  const { text: catalogText, warnings: catalogWarnings } = buildSpecCatalogText(runtime.specs);

  const prompt = buildDesignPrompt({
    instruction: state.instruction,
    catalogText,
    feedback: state.designFeedback,
  });

  const rawModel = runtime.llmFactory.createModel(runtime.modelId, {
    temperature: runtime.temperature,
  });
  const structuredModel = asStructuredOutputModel(rawModel).withStructuredOutput(
    PlannerDraftSchema,
    { method: 'functionCalling' }
  );

  const messages = [new SystemMessage(DESIGN_SYSTEM_PROMPT), new HumanMessage(prompt)];
  const rawOutput = await structuredModel.invoke(messages);
  // Defensive re-validation: a structured-output adapter (real or fake) can
  // still hand back a shape that only loosely matches — surface a loud ZodError
  // rather than silently trusting `rawOutput`.
  const plannerDraft: PlannerDraft = PlannerDraftSchema.parse(rawOutput);

  const idAssignment = buildIdAssignment(plannerDraft, state.idMap);

  const resolvedSpecByShortId = new Map<string, NodeSpec>();
  const nodeRows: Array<Omit<PipelineNodeRow, 'pipelineId'>> = plannerDraft.nodes.map((node) => {
    const spec = specsByKey.get(node.key);
    if (spec) resolvedSpecByShortId.set(node.id, spec);
    return {
      // An unresolved key falls back to 'TOOL' — a harmless placeholder never
      // surfaced as a successful result: validate() independently flags any
      // node whose key has no matching spec (NODE_TYPE_MISMATCH, reused —
      // see validate.node.ts), which routes back through correct() instead of
      // ever reaching a `validationIssues.length === 0` END.
      id: idAssignment.resolve(node.id),
      nodeType: spec?.nodeType ?? 'TOOL',
      key: node.key,
      label: node.label,
      inputs: remapInputs(node.inputs, idAssignment),
    };
  });

  const edgeRows: Array<Omit<PipelineEdgeRow, 'pipelineId'>> = plannerDraft.edges.map((edge) => ({
    id: crypto.randomUUID(),
    fromNodeId: idAssignment.resolve(edge.from),
    toNodeId: idAssignment.resolve(edge.to),
    label: edge.label,
  }));

  const specsByNodeId = new Map<string, NodeSpec>();
  for (const [shortId, spec] of resolvedSpecByShortId) {
    specsByNodeId.set(idAssignment.resolve(shortId), spec);
  }
  const filledNodes = applyAutoFill(nodeRows, edgeRows, specsByNodeId);
  const positionedNodes = computeLayeredPositions(filledNodes, edgeRows);

  const draft: PipelineDraft = {
    id: state.draft?.id,
    name: derivePipelineName(state.instruction),
    description: state.instruction,
    nodes: positionedNodes,
    edges: edgeRows,
  };

  return {
    draft,
    idMap: idAssignment.idMap,
    plannerWarnings: catalogWarnings,
    // Clear consumed feedback so a later successful attempt doesn't carry a
    // stale correction note around in state past the point it was acted on.
    designFeedback: undefined,
  };
}

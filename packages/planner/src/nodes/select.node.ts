import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  CatalogLoader,
  McpNodeResolver,
  NodeSpec,
  ResolvedProvider,
} from '@openpipeline/core';

import { checkAbort } from '../abort.js';
import {
  buildMcpCatalogText,
  buildSelectPrompt,
  buildSpecCatalogText,
  SELECT_SYSTEM_PROMPT,
} from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import { SelectSchema } from '../schema.js';
import type { PlannerState } from '../state.js';
import { asStructuredOutputModel } from '../structured-output.js';

/**
 * Narrows `runtime.catalogLoader`/`mcpNodeResolver` (optional on
 * `PlannerRuntime` — genuinely absent on the no-MCP path) to required, or
 * throws a clear, actionable error — a real runtime guard (mirrors
 * `asStructuredOutputModel`/`readPlannerState`'s style), not an `as` cast.
 * `buildPlannerGraph` only ever wires `select` into the compiled graph when
 * both are configured, so this should be structurally unreachable in
 * practice; it exists so a future wiring regression fails loudly here
 * instead of a confusing `undefined is not a function` a line later.
 */
function requireCatalogDeps(runtime: PlannerRuntime): {
  catalogLoader: CatalogLoader;
  mcpNodeResolver: McpNodeResolver;
} {
  if (!runtime.catalogLoader || !runtime.mcpNodeResolver) {
    throw new Error(
      '[PipelinePlanner] select node reached without a configured catalogLoader/mcpNodeResolver ' +
        '— this is a planner wiring bug (buildPlannerGraph should never route here on the no-MCP path).'
    );
  }
  return { catalogLoader: runtime.catalogLoader, mcpNodeResolver: runtime.mcpNodeResolver };
}

function validKeysOf(providers: readonly ResolvedProvider[]): Set<string> {
  const keys = new Set<string>();
  for (const provider of providers) {
    for (const tool of provider.tools) keys.add(`mcp:${provider.key}:${tool.name}`);
  }
  return keys;
}

/**
 * T2/D2's `select` node: loads the MCP catalog (cached on
 * `runtime.mcpCatalogBox` so a second entry into `select` within the same
 * `plan()` call — D2b's correct-routing extension — reuses it instead of
 * reloading), asks the model to pick `mcp:<provider>:<tool>` keys, and
 * resolves each one to a `NodeSpec` for `design` to use.
 *
 * Fail-soft, per D2:
 * - A selection with zero keys that are BOTH well-formed AND present in the
 *   loaded catalog ("invalid/empty") gets exactly one same-input retry. If
 *   the retry is also empty, a `plannerWarning` is appended and the run
 *   proceeds to `design` with static specs only — `mcpSpecs`/`mcpCatalogText`
 *   stay empty, never blocking the loop.
 * - Each individually selected key is resolved via
 *   `mcpNodeResolver.resolveSpec` in its own try/catch; a failure drops just
 *   that key (with its own `plannerWarning`), it never aborts the others.
 *
 * `select` always hands off to `design` unconditionally (no conditional edge
 * needed on its outgoing side) — whether or not any MCP tool ended up
 * resolved.
 */
export async function selectNode(
  state: PlannerState,
  runtime: PlannerRuntime
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  runtime.logger.debug(`[PipelinePlanner] select attempt=${String(state.attempts)}`);
  runtime.onProgress?.({ phase: 'select', attempt: state.attempts });

  const { catalogLoader, mcpNodeResolver } = requireCatalogDeps(runtime);

  if (!runtime.mcpCatalogBox.loaded) {
    runtime.mcpCatalogBox.loaded = await catalogLoader.load({
      userId: runtime.context.userId,
      tenantId: runtime.context.tenantId,
    });
  }
  const catalog = runtime.mcpCatalogBox.loaded;
  const validKeys = validKeysOf(catalog.providers);

  const catalogText = buildMcpCatalogText(catalog.providers);
  const prompt = buildSelectPrompt({
    instruction: state.instruction,
    taskSummary: state.taskSummary,
    catalogText,
  });
  const rawModel = runtime.llmFactory.createModel(runtime.modelId, {
    temperature: runtime.temperature,
  });
  const structuredModel = asStructuredOutputModel(rawModel).withStructuredOutput(SelectSchema, {
    method: 'functionCalling',
  });
  const messages = [new SystemMessage(SELECT_SYSTEM_PROMPT), new HumanMessage(prompt)];

  const attemptSelection = async (): Promise<string[]> => {
    const rawOutput = await structuredModel.invoke(messages);
    const parsed = SelectSchema.parse(rawOutput);
    return parsed.selectedKeys.filter((key) => validKeys.has(key));
  };

  let validSelectedKeys = await attemptSelection();
  if (validSelectedKeys.length === 0) {
    // Fail-soft: 1 same-input retry (D2) before giving up on this round.
    validSelectedKeys = await attemptSelection();
  }

  if (validSelectedKeys.length === 0) {
    return {
      selectedMcpKeys: [],
      mcpSpecs: [],
      mcpCatalogText: '',
      plannerWarnings: [
        '[select] no MCP tools were selected after a retry (empty or catalog-mismatched ' +
          'selection both times); proceeding to design with static specs only.',
      ],
    };
  }

  const resolvedSpecs: NodeSpec[] = [];
  const resolveWarnings: string[] = [];
  for (const key of validSelectedKeys) {
    try {
      const spec = await mcpNodeResolver.resolveSpec(key, {
        userId: runtime.context.userId,
        tenantId: runtime.context.tenantId,
        mcpCatalogCache: catalog.providers,
      });
      resolvedSpecs.push(spec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      resolveWarnings.push(
        `[select] failed to resolve MCP tool "${key}": ${reason}; excluded from the design catalog.`
      );
    }
  }

  const mcpCatalog = buildSpecCatalogText(resolvedSpecs);

  return {
    selectedMcpKeys: validSelectedKeys,
    mcpSpecs: resolvedSpecs,
    mcpCatalogText: mcpCatalog.text,
    plannerWarnings: [...resolveWarnings, ...mcpCatalog.warnings],
  };
}

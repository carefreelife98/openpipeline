import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  CatalogLoader,
  McpNodeResolver,
  NodeSpec,
  ResolvedProvider,
} from '@openpipeline/core';

import { checkAbort } from '../abort.js';
import { mergeResolvedMcpSpecs, unresolvedMcpKeysFromIssues } from '../mcp-routing.js';
import {
  buildMcpCatalogText,
  buildSelectPrompt,
  buildSpecCatalogText,
  SELECT_SYSTEM_PROMPT,
} from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import {
  classifyStructuredOutputError,
  describeStructuredOutputFailure,
  type StructuredOutputSchemaFailure,
} from '../schema-failure.js';
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
 * Returns only the entries of `candidates` not already present (exact string
 * match) in `existing` — keeps the APPEND-semantics `plannerWarnings` channel
 * (D7) free of duplicates when a node can legitimately run more than once per
 * `plan()` call, as `select` does on a D2b re-entry (T2 review Minor 3).
 */
function dedupeAgainstExisting(
  existing: readonly string[],
  candidates: readonly string[]
): string[] {
  const seen = new Set(existing);
  return candidates.filter((candidate) => !seen.has(candidate));
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
 *   loaded catalog ("invalid/empty") gets exactly one same-input retry. This
 *   also covers a response that fails `SelectSchema.parse` entirely (T2
 *   review Important 1 — the most literal "invalid selection" there is;
 *   previously an unguarded `.parse()` let a `ZodError` reject the whole
 *   `plan()`, unlike every other fail-soft path in this package): a schema
 *   mismatch is treated as zero valid keys for that attempt, same as an
 *   empty/mismatched array. If the retry is also empty, a `plannerWarning`
 *   (naming the schema failure when that's what happened) is appended and the
 *   run proceeds to `design` with static specs only. On a D2b re-entry (this
 *   isn't `select`'s first call this `plan()`), `mcpSpecs`/`mcpCatalogText`
 *   are left untouched rather than reset to empty (T2 review Minor 4) — an
 *   earlier round's resolved specs must survive an empty re-selection, or a
 *   draft that still legitimately references one of them would fail
 *   `validate` as an unknown key.
 * - Each individually selected key is resolved via
 *   `mcpNodeResolver.resolveSpec` in its own try/catch; a failure drops just
 *   that key (with its own `plannerWarning`), it never aborts the others. A
 *   non-empty D2b re-entry merges its freshly-resolved specs with whatever an
 *   EARLIER round already resolved (`mergeResolvedMcpSpecs`, keyed by
 *   `spec.key`, this round's resolution winning on a collision) rather than
 *   replacing `state.mcpSpecs` outright — the same preservation semantics the
 *   empty-selection branch already has (T2 review Minor 4), unified across
 *   both branches (T2 re-review round 2, Minor-4 residual, carried over to
 *   T3): otherwise a re-selection that resolves ANY key at all, even a
 *   disjoint one, would silently drop an earlier round's still-referenced
 *   key and force an extra correction round to rediscover it.
 * - Every `plannerWarnings` entry this node returns is deduped against
 *   `state.plannerWarnings` first (T2 review Minor 3): `select` can run more
 *   than once per `plan()` call (D2b), and the APPEND-semantics channel would
 *   otherwise collect the identical message once per re-entry.
 * - A D2b re-entry (`state.validationIssues`/`state.draft` name an
 *   unresolved `mcp:` key — the same condition `correct.node.ts` used to
 *   route back here) is no longer a byte-identical re-roll of the first
 *   call's prompt (T3 review llm-robustness #2): `buildSelectPrompt` gets an
 *   extra re-entry section naming the specific key(s) that didn't resolve
 *   (must be dropped or replaced) and the key(s) already resolved by an
 *   earlier round (still available, no need to re-select), so a
 *   temperature-only re-roll is no longer the ONLY thing that can change the
 *   model's answer.
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

  // T3 review llm-robustness #2: `unresolvedKeys` is non-empty exactly when
  // this call is a D2b re-entry (`correct.node.ts` routed here because
  // `issuesReferenceUnresolvedMcpKey(state.validationIssues, state.draft)`
  // was true — same inputs, same predicate, just the actual key list instead
  // of a boolean) — first-ever calls this `plan()` always have an empty
  // `state.validationIssues`/`undefined` `state.draft`, so `reentry` is
  // correctly omitted for them.
  const unresolvedKeys = unresolvedMcpKeysFromIssues(state.validationIssues, state.draft);
  const alreadyResolvedKeys = (state.mcpSpecs ?? []).map((spec) => spec.key);

  const catalogText = buildMcpCatalogText(catalog.providers);
  const prompt = buildSelectPrompt({
    instruction: state.instruction,
    taskSummary: state.taskSummary,
    catalogText,
    reentry:
      unresolvedKeys.length > 0 ? { unresolvedKeys, resolvedKeys: alreadyResolvedKeys } : undefined,
  });
  const rawModel = runtime.llmFactory.createModel(runtime.modelId, {
    temperature: runtime.temperature,
  });
  const structuredModel = asStructuredOutputModel(rawModel).withStructuredOutput(SelectSchema, {
    method: 'functionCalling',
  });
  const messages = [new SystemMessage(SELECT_SYSTEM_PROMPT), new HumanMessage(prompt)];

  // T2 review Important 1 / T3 review llm-robustness #1: a call that fails
  // schema validation — either `SelectSchema.parse` throwing (a schema-SHAPE
  // defect, not an empty/mismatched selection) or `structuredModel.invoke`
  // itself rejecting with an `OutputParserException` (a provider
  // `functionCalling` adapter validates its own zod schema INSIDE `invoke` —
  // see `design.node.ts`'s matching comment) — is caught here (a single
  // `try` spans both) and treated as zero valid keys for that attempt,
  // feeding the same one-retry-then-warn fail-soft path below instead of
  // letting the raw error propagate out of the node and reject `plan()`. Any
  // other error (a genuine LLM/network failure) still rethrows.
  let lastSchemaFailure: StructuredOutputSchemaFailure | undefined;
  const attemptSelection = async (): Promise<string[]> => {
    try {
      const rawOutput = await structuredModel.invoke(messages);
      const parsed = SelectSchema.parse(rawOutput);
      return parsed.selectedKeys.filter((key) => validKeys.has(key));
    } catch (err) {
      const failure = classifyStructuredOutputError(err);
      if (!failure) throw err;
      lastSchemaFailure = failure;
      return [];
    }
  };

  let validSelectedKeys = await attemptSelection();
  if (validSelectedKeys.length === 0) {
    // Fail-soft: 1 same-input retry (D2) before giving up on this round.
    validSelectedKeys = await attemptSelection();
  }

  if (validSelectedKeys.length === 0) {
    // T2 review Minor 4: `state.mcpSpecs` may already hold keys resolved by
    // an EARLIER `select` round within this same `plan()` call (D2b
    // re-entry). Omit the keys entirely (rather than writing `[]`/`''`) so
    // the last-write-wins `mcpSpecs`/`mcpCatalogText` channels keep whatever
    // an earlier round resolved; only reset them on a genuine first-ever
    // empty selection.
    const hadPriorSpecs = (state.mcpSpecs?.length ?? 0) > 0;
    const warning = lastSchemaFailure
      ? `[select] structured output did not match the required schema after a retry ` +
        `(${describeStructuredOutputFailure(lastSchemaFailure)}); proceeding to design with static specs only.`
      : '[select] no MCP tools were selected after a retry (empty or catalog-mismatched ' +
        'selection both times); proceeding to design with static specs only.';
    return {
      ...(hadPriorSpecs ? {} : { mcpSpecs: [], mcpCatalogText: '' }),
      plannerWarnings: dedupeAgainstExisting(state.plannerWarnings, [warning]),
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

  // T2 re-review round 2 (Minor-4 residual, carried over to T3): merge THIS
  // round's resolved specs with whatever an earlier D2b round already
  // resolved, instead of replacing `state.mcpSpecs` outright — an earlier
  // round's key that this round simply didn't re-select must survive, not
  // just an earlier round's key when this round selects nothing at all
  // (which the empty branch above already handled). `mcpCatalogText` is
  // rebuilt from the SAME merged set so the two channels never disagree
  // about which specs are actually available to `design`.
  const mergedSpecs = mergeResolvedMcpSpecs(state.mcpSpecs, resolvedSpecs);
  const mcpCatalog = buildSpecCatalogText(mergedSpecs);

  return {
    mcpSpecs: mergedSpecs,
    mcpCatalogText: mcpCatalog.text,
    plannerWarnings: dedupeAgainstExisting(state.plannerWarnings, [
      ...resolveWarnings,
      ...mcpCatalog.warnings,
    ]),
  };
}

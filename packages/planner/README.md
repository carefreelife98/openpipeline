# @openpipeline/planner

Natural-language pipeline planner for OpenPipeline: an LLM-driven design -> validate -> correct loop over LangGraph that turns an instruction into a valid `PipelineDraft`.

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/planner
```

## Usage

```ts
import { PipelinePlanner } from '@openpipeline/planner';

const planner = new PipelinePlanner({
  llmFactory,
  modelId: 'gpt-4o',
  specs: () => registry.list(),
});

const result = await planner.plan({ instruction: 'Summarize the input text and shout it.' });
console.log(result.draft, result.attempts, result.plannerWarnings);
```

`plan()` runs a `design -> validate -> correct` LangGraph loop: the model proposes a draft using short ids (`n1`, `n2`, ...), the draft is validated against `@openpipeline/nodes`'s `validateGraph` plus the IF-branch rule, and failures are fed back to the model (with short ids, never the persisted UUIDs) for up to `maxAttempts` tries.

The result (`PlannerResult`) is a ready-to-persist `@openpipeline/core` `PipelineDraft` — hand it straight to `PipelineEngine.save()`:

```ts
import { PipelineEngine } from '@openpipeline/runtime';

const { draft, attempts, unresolvedValidationErrors, plannerWarnings } = await planner.plan({
  instruction: 'Fetch the latest release notes and summarize them.',
});
if (unresolvedValidationErrors) {
  // maxAttempts was exhausted with the draft still failing validation — inspect
  // `unresolvedValidationErrors` (GraphValidationIssue[]) before persisting it.
}

const pipelineId = await engine.save(draft);
const { runId, done } = await engine.run({ pipelineId });
```

`maxAttempts` exhaustion has two different shapes, and only one of them is a rejection:

- **Exhausted WITH a draft** (every attempt produced a `PlannerDraft`, but none ever passed validation): `plan()` still **resolves** normally, with `PlannerResult.unresolvedValidationErrors` set to the last round's issues — the `if (unresolvedValidationErrors)` branch above.
- **Exhausted WITH NO draft** (every attempt, including the last, failed `PlannerDraftSchema.parse` — a schema-shape defect, not a graph-structure one): `plan()` **rejects** with a typed `PlannerExhaustedError` (`extends Error`, `readonly attempts: number`, `readonly lastIssues?: GraphValidationIssue[]`), instead of a bare `Error` — there is no draft to attach `unresolvedValidationErrors` to, so throwing is the only option. Classify it via `instanceof`, not by matching the error message:

```ts
import { PlannerExhaustedError } from '@openpipeline/planner';

try {
  const { draft } = await planner.plan({ instruction: '...' });
} catch (err) {
  if (err instanceof PlannerExhaustedError) {
    // err.attempts, err.lastIssues (GraphValidationIssue[] | undefined)
  }
  throw err;
}
```

See [`examples/planner-quickstart`](https://github.com/carefreelife98/openpipeline/tree/main/examples/planner-quickstart) for a complete, runnable version of this instruction -> `plan()` -> `save()` -> `run()` flow (deterministic, zero API keys).

## MCP tool selection (`intent -> select`)

Opt-in: pass both `catalogLoader` and `mcpNodeResolver` together to enable an `intent -> select` step ahead of `design` — the same interfaces `PipelineEngine` itself accepts for the `mcp:*` node path (see the [root README](https://github.com/carefreelife98/openpipeline#readme)'s "MCP tools" section and [`examples/mcp`](https://github.com/carefreelife98/openpipeline/tree/main/examples/mcp)):

```ts
import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openpipeline/mcp';
import { PipelinePlanner } from '@openpipeline/planner';

const planner = new PipelinePlanner({
  llmFactory,
  modelId: 'gpt-4o',
  specs: () => registry.list(),
  catalogLoader: createEnvCatalogLoader({
    servers: [
      {
        key: 'github',
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        authType: 'none',
        env: { GITHUB_TOKEN: process.env.GH_TOKEN! },
      },
    ],
  }),
  mcpNodeResolver: new McpNodeResolverImpl(),
});

const result = await planner.plan({
  instruction: "Open a GitHub issue summarizing today's errors.",
});
// result.draft may now include mcp:github:<tool> nodes the planner selected and resolved.
```

What this changes about `plan()`:

- **`intent` decides whether the instruction needs an MCP tool at all.** `needsMcp: false` skips `select`'s catalog load and LLM call entirely — the run falls straight through to the same static-specs-only `design -> validate -> correct` loop as the no-MCP build.
- **`select` picks `mcp:<provider>:<tool>` keys from the loaded catalog** and resolves each independently via `mcpNodeResolver.resolveSpec` (fail-soft per key — one bad resolution never drops the others). An empty or schema-invalid selection gets one same-input retry, then a `plannerWarning` and the run proceeds with static specs only.
- **A validation error naming an unresolved `mcp:` key routes the correction loop back to `select`** (not `design`) so the model gets another chance to pick a different tool; every other validation failure routes to `design` as usual. A later `select` re-entry within the same `plan()` call always merges with (never replaces) an earlier round's resolved specs, keyed by `spec.key` — a tool resolved in an earlier round stays available even if a later round doesn't re-select it.
- **The catalog is loaded at most once per `plan()` call on the success path** (cached across `select` re-entries) and its `cleanup()` runs exactly once, on every exit path (success, failure, or abort). A failed `load()` is NOT cached — nothing is stored to reuse — so a later `select` re-entry (e.g. a validation error naming an unresolved `mcp:` key routing back from `correct`) retries `catalogLoader.load()` from scratch, paying the full transport cost again each time. See the `select` node's doc comment and CHANGELOG `0.5.1` for the DESIGN DECISION this follows from.

Passing only one of `catalogLoader`/`mcpNodeResolver` throws synchronously from the constructor — neither option alone is enough to load a catalog AND resolve a selection from it. Omit both for the static-specs-only path (`design -> validate -> correct`, unchanged from the no-MCP build).

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT

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

> **No-MCP build:** this version only supports the static-specs path (`specs`). Passing `catalogLoader` or `mcpNodeResolver` — the MCP tool-selection (`intent -> select`) routing — throws synchronously from the constructor; that path isn't implemented yet (tracked for a follow-up task). Construct `PipelinePlanner` without those two options.

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT

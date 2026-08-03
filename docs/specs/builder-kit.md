# Builder kit — palette, inspector, validation display

**Status:** spec (no code yet) · **Target:** `@openpipeline/react` 0.6.0
**Owner package:** `@openpipeline/react` — no new package (see [Explicit non-goals](#explicit-non-goals))

## TL;DR

`@openpipeline/react` ships one controlled component today, `<BuilderCanvas/>`.
This spec decomposes the next layer — a node palette, a schema-driven node
inspector, and a validation-issue display — into three more controlled
components in the **same** package, following the **same** conventions
(peer deps, inline styles, `strings`-prop i18n, consumer owns data/auth).

The inspector's "reference another node's output" picker needs client-side
topological-ancestor computation. That turns out to need nothing beyond what
`@openpipeline/react` can already reach: `computeAncestors` already lives in
`@openpipeline/core` (already a dependency), and this spec's validation
types are defined structurally enough that no import of `@openpipeline/nodes`
is required either. So the package-boundary question this decomposition
might have forced — does `@openpipeline/react` gain a dependency on
`@openpipeline/nodes`, or does something move — has a one-line answer: no
boundary change needed. See [Ancestor computation and the package
boundary](#ancestor-computation-and-the-package-boundary).

Every claim about current code below was checked by reading the actual
source in this worktree (see file:line citations throughout) — nothing here
is a guess about what `@openpipeline/react`, `@openpipeline/core`, or
`@openpipeline/nodes` currently do.

## Goals

1. Decompose `<BuilderCanvas/>`'s implicit "you also need a palette and an
   inspector, go build your own" gap into shipped, composable, controlled
   components — palette (`NodePalette`), inspector (`InspectorPanel` +
   `StatePathPicker`), and validation display (`ValidationDisplay`).
2. Design every editor and default-value path so a slot's binding can never
   silently commit a value of the wrong runtime type (a string where the
   schema declares an object, `NaN` where it declares a number, a bare-string
   fallback for an array) and can never silently fall back to a raw-text
   editor for a type the schema actually declares more precisely (a nullable
   primitive collapsing to "everything else" instead of getting its real
   typed editor). Both are structurally eliminated, not just tested against,
   by routing every commit through one small set of shared, standalone
   utilities.
3. Resolve whether the ancestor-computation picker forces a new package
   dependency, with an argued answer grounded in this package's actual
   current dependency graph, not assumed.
4. Keep every new component "adopt what you need": each ships as a
   standalone export, and the lower-level pieces each is built from (the
   binding-default utilities, the state-path tree builder, the issue-pruning
   helper) are *also* individually exported.

## Positioning tie-in

OpenPipeline's customer is a developer embedding user-editable workflow
automation into their product; the people actually assembling pipelines are
that developer's non-developer end users. The builder kit is the concrete
answer to "how does my product's UI let a non-developer build a graph
without me hand-rolling a palette, a per-node-type settings form, and an
error list myself." A typed `NodeSpec` registry with zod input/output
schemas already exists in `@openpipeline/core`/`@openpipeline/nodes` and
`validateGraph` already exists to reject bad user-authored graphs — the
builder kit is the UI layer that makes those two facts usable without every
integrator re-deriving the same schema-to-form mapping, and the same
type-coercion bugs, from scratch. It is still built **on top of** LangGraph
(the compiled graph a pipeline runs as), not competing with it — this spec
adds no new relationship to LangGraph beyond what `@openpipeline/core`
already has.

## Current-state facts this spec is built on

Verified by reading the actual files (not assumed):

- `computeAncestors` and `analyzeTopology` **already live in
  `@openpipeline/core`** (`packages/core/src/topology.ts`), not
  `@openpipeline/nodes`. `packages/nodes/src/graph-validator.ts:1-8` imports
  both of them *from* `@openpipeline/core`.
- `validateGraph` / `toCompiledNodeMap` / `GraphValidationIssue` are the only
  pieces still in `@openpipeline/nodes` (`packages/nodes/src/graph-validator.ts`).
  That file itself imports only `@openpipeline/core` and `zod` — **it does
  not import `@langchain/langgraph` or `@langchain/core`** directly.
- `@openpipeline/nodes`'s *package* nonetheless depends on
  `@langchain/langgraph` (`packages/nodes/src/compiler.ts:1`, `StateGraph`/
  `START`/`END`) and peer-depends on `@langchain/core`
  (`packages/nodes/src/built-in/llm-node.ts:1`) — both real, both required
  to install `@openpipeline/nodes` at all, both irrelevant to a browser-side
  validator or ancestor picker.
- `@openpipeline/core` is **not** langgraph-free either:
  `packages/core/src/state.ts:1-2` imports `Annotation`/`AnnotationRoot`/
  `StateDefinition` from `@langchain/langgraph`, and
  `packages/core/package.json` lists `@langchain/langgraph` under
  `dependencies` (a hard dependency, not a peer). `Annotation.Root(...)` at
  `state.ts:166` also runs at module-eval time, i.e. it is not purely a type
  import. This matters directly for [Ancestor computation and the package
  boundary](#ancestor-computation-and-the-package-boundary) below.
- `@openpipeline/react` currently has **zero runtime dependency on zod**
  (`packages/react/package.json` — no `zod` entry anywhere) and its only use
  of `@openpipeline/core` today is **type-only**
  (`packages/react/src/store/builder-store.ts:1`,
  `packages/react/src/types.ts:1`: `import type { ... } from '@openpipeline/core'`).
  Any new *runtime* (non-type) import from `@openpipeline/core` — e.g.
  calling `computeAncestors` — is new ground for this package.
- `NodeSpecDescriptor` (`packages/react/src/types.ts:26-35`) today carries a
  flattened `inputs?: Array<{ name; required; description? }>` — enough for
  a required-badge but not enough for a schema-driven form. There is no
  `inputSchema`/`outputSchema` field. The playground backend hand-authors
  this flattened shape directly (`examples/playground/backend.ts:69-90`)
  rather than deriving it from each node's real zod `inputSchema`.
- `GraphValidationIssue` (`packages/nodes/src/graph-validator.ts:11-22`) has
  **no `source`/provenance field** — every issue `validateGraph` produces is
  from the same compile-time gate and is inherently "blocking." The planner
  package (`packages/planner/src/types.ts:75`) distinguishes an
  auto-generated, not-yet-fully-corrected draft via a *separate field name*,
  `unresolvedValidationErrors?: GraphValidationIssue[]`, rather than an
  in-band discriminant on the issue type itself. Any tone/severity split
  (advisory vs. blocking) therefore cannot be inferred from the issue shape
  itself — see [ValidationDisplay](#4-validationdisplay) for how the tone
  split is handled instead.
- `<BuilderCanvas/>` has no drop-target handling today
  (`packages/react/src/canvas/BuilderCanvas.tsx` wires `onConnect`/
  `onNodesChange`/`onEdgesChange` only) — adding a palette with a drag
  source means `BuilderCanvas` needs a small, additive drop-target change
  too. Flagged explicitly in the [phased plan](#phased-implementation-plan)
  so it isn't a surprise mid-implementation.
- `PipelineState` (`packages/core/src/state.ts:106-112`) has exactly five
  channels: `meta`, `outputs`, `nodeMeta`, `cost`, `events`. `PipelineMeta`
  (`state.ts:23-40`) is a **closed** shape (`runId`, `pipelineId`,
  `pipelineName`, `pipelineDescription`, `deliveryMode`, `context?:
  { userId?, tenantId?, getOAuthToken? }`, `mcpCatalogCache?`), not a
  free-form host payload, and `RunOptions`
  (`packages/runtime/src/index.ts:108-123`) accepts no consumer-supplied
  graph-level run input at all — only `context`. This directly grounds
  [`StatePathPicker`'s built-in `meta` root](#3-statepathpicker) (below):
  `meta.*` is the only non-node-output path prefix anything in
  `PipelineState` can resolve today.
- `PipelineCompileError` (`packages/core/src/errors.ts:4-20`) carries
  `entries: CompileErrorEntry[]`, `{ scope: 'graph' | 'node'; kind: string;
  message: string; nodeId?: string; nodeKey?: string }` — thrown at three
  sites in `packages/nodes/src/compiler.ts` (`87-95` `TOPOLOGY_NO_ENTRY`,
  `127-140` wrapping every `validateGraph` issue with `kind: i.code`,
  `191-199` `IF_MISSING_BRANCH`), i.e. inside `PipelineCompiler.compile()` /
  `engine.run()` only. `entry.kind`'s actual value set is therefore a
  **superset** of `GraphValidationIssue['code']` — it also includes
  `TOPOLOGY_NO_ENTRY`/`IF_MISSING_BRANCH`, which never come from
  `validateGraph` and are not in that type's closed union. This matters for
  [`ValidationDisplay`](#4-validationdisplay)'s adapter below.
- `validateGraph(graph, specs: ReadonlyMap<string, NodeSpec>)`
  (`packages/nodes/src/graph-validator.ts:125-128`) requires **live zod
  `NodeSpec` objects**: `spec.inputSchema instanceof z.ZodObject` (`:246`),
  `field.safeParse(undefined)` (`:64`), `field instanceof z.ZodDefault`
  (`:249`). `NodeSpec` itself (`packages/core/src/node-spec.ts:83-99`)
  requires `inputSchema: z.ZodType`, `outputSchema: z.ZodType`, and a
  `handler`. The browser, by this spec's own design, only ever holds
  `NodeSpecDescriptor` with a JSON-Schema-shaped `inputSchema`/
  `outputSchema` — never a live zod `NodeSpec` — and an MCP-sourced node's
  `handler` closes over a server-side client that has no browser equivalent
  at all. So `validateGraph` cannot run client-side, for any catalog shape
  this spec could define. This matters directly for
  [`ValidationDisplay`](#4-validationdisplay) below.
- `CompiledNode` (`packages/core/src/graph.ts:47-52`) is `{ node:
  PipelineNodeRow; spec: NodeSpec; predecessors; successors }`.
  `PipelineNodeRow` (`graph.ts:17-27`) requires `pipelineId`; `BuilderNode`
  (`packages/react/src/types.ts:4-12`) has no such field, and `spec:
  NodeSpec` again requires the live zod object neither the palette nor the
  catalog descriptor carries in the browser. So `CompiledNode` is not
  constructible from data `@openpipeline/react` actually holds. This
  matters directly for [`StatePathPicker`](#3-statepathpicker)'s worked
  example below.

## Shared type additions

All three components consume a JSON-Schema-*shaped* type, not a live zod
object — a deliberate continuation of the "zero zod dependency" fact above:
the catalog wire format crossing into the UI is always already-converted
JSON Schema, never a zod instance. The *producer* of this JSON Schema (the
consumer's own catalog endpoint, using zod v4's built-in `z.toJSONSchema()`
or the `zod-to-json-schema` package for zod v3) is the consumer's
responsibility, exactly like `NodeSpecDescriptor` already is today.

```ts
// packages/react/src/types.ts (extended)

/**
 * The subset of JSON Schema the builder kit's editors switch on. Not a full
 * JSON Schema implementation — unknown keywords pass through untouched
 * (forward-compatible with whatever zod-to-json-schema/z.toJSONSchema emits).
 */
export interface SlotJsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null' | string;
  enum?: unknown[];
  items?: SlotJsonSchema;
  properties?: Record<string, SlotJsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  examples?: unknown[];
  description?: string;
  /**
   * Union representation for nullable/optional-variant fields — both zod v3
   * (`zod-to-json-schema`) and zod v4's `z.toJSONSchema()` emit `anyOf` for
   * `.nullable()`; `oneOf` is treated identically by every consumer of this
   * type below. See `unwrapNullableUnion` in
   * `packages/react/src/lib/json-schema.ts` for how a single-non-null-variant
   * union is collapsed before editor dispatch.
   */
  anyOf?: SlotJsonSchema[];
  oneOf?: SlotJsonSchema[];
  /**
   * Root-wrapper shape a JSON Schema producer can emit when the schema being
   * converted has a genuine cycle, or — for a `zod-to-json-schema` (zod v3)
   * caller that passes a `name` argument — whenever it does at all: `{ $ref:
   * '#/definitions/X', definitions: { X: {...} } }` (v3, named) or `{ $ref:
   * '#/$defs/X', $defs: { X: {...} } }` (v4, `reused: 'ref'` or a cyclic
   * schema). Measured against this repo's own installed zod/
   * zod-to-json-schema versions: reuse and nesting alone do **not** produce
   * this wrapper — v4's default is to inline reused sub-schemas, and v3's
   * default (no `name` argument) inlines too. Only a genuine cycle, or an
   * explicit `name`/`reused: 'ref'` producer, wraps the root. See
   * `unwrapJsonSchema` below — it is a defensive no-op for the common case
   * and a real fix for the cyclic/named-producer case.
   */
  $ref?: string;
  $defs?: Record<string, SlotJsonSchema>;
  definitions?: Record<string, SlotJsonSchema>;
  [key: string]: unknown;
}
```

**`unwrapJsonSchema` — a defensive utility, always safe to call.** A
root-`$ref`-wrapped `NodeSpecDescriptor.inputSchema` has no top-level
`properties`, and `InspectorPanel`'s render loop would silently produce zero
slots for it. That wrapper is not the common case (see the note on `$ref`
above — a typical node schema converts inline), but it is a real one: any
input/output schema with a genuine cycle, or produced by a
`zod-to-json-schema`-style call that names the root type, arrives wrapped.
Rather than require every catalog producer to reason about which conversion
path they're on, `InspectorPanel` and `buildStatePathTree` both call
`unwrapJsonSchema` unconditionally — a no-op when there's nothing to unwrap,
a fix when there is.

```ts
// packages/react/src/lib/json-schema.ts

/**
 * Resolves a top-level `$ref` against whichever bag the ref string itself
 * points at — `#/$defs/...` against `$defs` (zod v4), `#/definitions/...`
 * against `definitions` (zod v3 `zod-to-json-schema`) — and returns the
 * dereferenced schema. A no-op (returns `schema` unchanged) when there is no
 * root `$ref`, so it is always safe to call unconditionally rather than
 * only when a wrapper is suspected. The prefix, not just bag presence,
 * decides which bag to read: a schema carrying both `$defs` and a legacy
 * `definitions` (e.g. re-serialized through more than one converter) must
 * not resolve a `#/definitions/X` ref against `$defs` by accident.
 *
 * Unifies what would otherwise be two independent unwrap implementations —
 * one for `InspectorPanel`'s `inputSchema` walk, one for
 * `buildStatePathTree`'s `outputSchema` walk — into this single shared
 * utility, called internally by both, so a consumer never has to remember
 * to call it themselves.
 *
 * **Depth policy — root only, one level, stated explicitly (Phase 1)**: a
 * *property* whose own value is a `$ref` (rather than the schema's root) is
 * **not** dereferenced by this function; `SlotField` renders it with its
 * no-declared-`type` fallback editor (a raw-JSON textarea) rather than a
 * typed one. Full multi-level `$ref` resolution (walking into
 * `$defs`/`definitions` for every nested `$ref`, with a cycle guard for a
 * genuinely recursive type) is tracked as [Phase 3 item
 * 10](#phased-implementation-plan), not solved here.
 */
export function unwrapJsonSchema(schema: SlotJsonSchema | undefined): SlotJsonSchema {
  if (schema == null) return {};
  if (typeof schema.$ref !== 'string') return schema;
  const usesDefs = schema.$ref.startsWith('#/$defs/');
  const usesDefinitions = schema.$ref.startsWith('#/definitions/');
  if (!usesDefs && !usesDefinitions) return schema;
  const bag = usesDefs ? schema.$defs : schema.definitions;
  if (!bag) return schema;
  const refKey = schema.$ref.slice(usesDefs ? '#/$defs/'.length : '#/definitions/'.length);
  const resolved = bag[refKey];
  return resolved ?? schema;
}

/**
 * Collapses a nullable-union `anyOf`/`oneOf` (e.g. `z.number().nullable()`'s
 * `{ anyOf: [{ type: 'number' }, { type: 'null' }] }`, produced identically
 * by zod v3 and v4) down to its single non-null variant, so a nullable slot
 * gets that variant's typed editor instead of falling through to the
 * catch-all text-input row. A no-op — returns `schema` unchanged — for a
 * union with zero or more than one non-null variant (nothing to collapse to
 * safely), so it is always safe to call unconditionally, like
 * `unwrapJsonSchema`. `SlotField`'s editor dispatch,
 * `coerceLiteralToSchemaType`, and `literalDefaultForType` (below) all call
 * this before switching on `schema.type` — without it, a nullable number
 * slot would dispatch to the text-input row and commit a **string** literal
 * against a schema that declares `number`, which is exactly the class of
 * bug `binding-defaults.ts` exists to make structurally impossible; a union
 * is not a special case that bug class gets to skip.
 */
export function unwrapNullableUnion(schema: SlotJsonSchema): SlotJsonSchema {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return schema;
  const nonNull = variants.filter((v) => v.type !== 'null');
  if (nonNull.length !== 1) return schema;
  return nonNull[0];
}

export interface NodeSpecDescriptor {
  key: string;
  nodeType: NodeType;
  displayName: string;
  description: string;
  icon: string;
  /**
   * @deprecated Superseded by `inputSchema`. Kept through the 0.6.0
   * migration window because `examples/playground/backend.ts` and any
   * existing consumer (e.g. `openpipeline-scheduler`) already produce this
   * shape; InspectorPanel does not read it.
   */
  inputs?: Array<{ name: string; required: boolean; description?: string }>;
  /** Full JSON Schema for the node's input slots (top-level `type: 'object'`). Powers InspectorPanel. */
  inputSchema?: SlotJsonSchema;
  /** Full JSON Schema for the node's output shape. Powers StatePathPicker's ancestor field walk. */
  outputSchema?: SlotJsonSchema;
  meta?: Record<string, unknown>;
}
```

`ValueBinding`'s shape is unchanged — it's defined in `@openpipeline/core`
and already imported (type-only) into `packages/react/src/types.ts:1,57`,
and its 3-kind `literal | state | auto` union is exactly the model these
components edit. It is **not** yet re-exported from the package's public
entry point (`packages/react/src/index.ts` forwards only `BuilderNode`,
`BuilderEdge`, `NodeSpecDescriptor`, `NodeRunStatus`, `BuilderStrings`,
`DEFAULT_STRINGS` today) — making it (and the other types these new
components' public props use) importable from `@openpipeline/react` directly
is a required Phase 1 step, not an existing fact; see [the phased
plan](#phased-implementation-plan).

---

## Component contracts

### 1. `NodePalette`

```ts
export interface PaletteSection {
  id: string;
  label: string;
  specs: NodeSpecDescriptor[];
}

export interface McpProviderCompatSummary {
  providerKey: string;
  providerDisplayName: string;
  /** Tools this provider exposed that the catalog silently dropped because their schema didn't convert to zod — see `NODE_MCP_SCHEMA_INCOMPATIBLE` below. */
  unsupportedToolCount: number;
}

export interface NodePaletteProps {
  catalog: NodeSpecDescriptor[];
  loading?: boolean;
  error?: string | null;
  /**
   * Groups the catalog into sections. Default: one section per `NodeType`
   * (`TOOL` / `LLM` / `IF` / `MCP_TOOL`), in `NODE_TYPE` enum order. A
   * consumer wanting to group MCP tools by provider supplies their own
   * function reading `spec.meta` (shaped like `McpNodeSpecMeta` from
   * `@openpipeline/core` for MCP-sourced specs) — see the example below.
   * Not shipped as a default because grouping-by-provider is a product
   * decision, not a kit concern.
   */
  groupBy?: (catalog: NodeSpecDescriptor[]) => PaletteSection[];
  /** Per-entry disabled state + reason — a hook instead of a hardcoded per-tool skip, so hiding a catalog entry without removing it from the catalog is always the consumer's call. */
  isDisabled?: (spec: NodeSpecDescriptor) => { disabled: boolean; reason?: string };
  /** Custom icon rendering — the kit ships no icon set (matches `PipelineNodeCard`'s "no CSS framework imposed" convention). Defaults to rendering `spec.icon` as plain text. */
  renderIcon?: (spec: NodeSpecDescriptor) => React.ReactNode;
  /**
   * Per-MCP-provider tool-compatibility summary, keyed by `providerKey`. In
   * scope for 0.6.0: OpenPipeline's own MCP resolver already computes this
   * fact server-side (`packages/mcp/src/node-resolver.ts:90-93` emits
   * `NODE_MCP_SCHEMA_INCOMPATIBLE` for any tool whose schema doesn't
   * convert to zod, and silently excludes it from the catalog) — a
   * provider section with tools missing from the palette and no visible
   * explanation is a real, live surface, not a hypothetical one.
   * `NodePalette` renders an amber "N unsupported" pill next to a
   * provider's section label when an entry for that `providerKey` is
   * present in this map with `unsupportedToolCount > 0`; omitted entirely
   * (no pill) when the map has no entry for that provider. Populating the
   * map (calling the catalog endpoint and counting skip reasons) is the
   * consumer's job, matching every other data-loading seam in this
   * component.
   */
  providerCompat?: Record<string, McpProviderCompatSummary>;
  onAddNode: (spec: NodeSpecDescriptor) => void;
  strings?: Partial<PaletteStrings>;
  className?: string;
  style?: React.CSSProperties;
}

export interface PaletteStrings {
  searchPlaceholder: string;
  loading: string;
  loadError: string;
  empty: string;
  noMatches: string;
  unsupportedToolsPill: (n: number) => string;
}

export const DEFAULT_PALETTE_STRINGS: PaletteStrings = {
  searchPlaceholder: 'Search nodes…',
  loading: 'Loading…',
  loadError: 'Failed to load the node catalog.',
  empty: 'No nodes available.',
  noMatches: 'No matching nodes.',
  unsupportedToolsPill: (n) => `${n} unsupported`,
};

/** The drag-source contract a drop target (BuilderCanvas or your own) decodes. */
export const OPENPIPELINE_NODE_MIME = 'application/x-openpipeline-node';
export interface NodeDragPayload {
  key: string;
  nodeType: NodeType;
}
export function encodeNodeDragPayload(spec: NodeSpecDescriptor): string; // JSON.stringify({ key, nodeType })
export function decodeNodeDragPayload(dataTransfer: DataTransfer): NodeDragPayload | null;
```

**In scope:**

| Behavior | Notes |
|---|---|
| Substring search on `displayName`/`description`, force-expand matching sections while searching, revert to the manual expand/collapse state on clear | Internal component state — no prop needed, purely presentational |
| Click-to-add fallback alongside drag, so keyboard/touch users aren't drag-only | `onAddNode` is the click path; a consumer wanting a jittered default position for repeated quick-adds does it in their own `onAddNode` handler (the playground example already does this, `examples/playground/src/App.tsx:115-125`) |
| Catalog/visibility decoupling — hiding a spec from the palette without removing it from the catalog | Exposed as `isDisabled`, a hook, not a hardcoded key |
| Neutral-icon-by-default, color reserved for status, not category | A stated design principle for `renderIcon`'s default (plain text, no color) — a consumer's own `renderIcon` can do anything |
| Drag payload as a minimal, documented MIME contract | `OPENPIPELINE_NODE_MIME` + typed encode/decode helpers — this package's own public contract |
| Per-provider "N unsupported" compatibility pill | See `providerCompat` above — see also [Seam completeness (a)](#seam-completeness-four-open-questions) |

**Out of scope:**

- Any built-in HTTP/fetch client, session handling, or i18n-cookie logic —
  `NodePalette` takes `catalog` as a prop; fetching is entirely the
  consumer's, matching every other data-loading seam in this package
  (`examples/playground/src/App.tsx:28-49` already does this today).
- Any built-in icon set or icon-provider integration — `renderIcon` is the
  seam; the kit ships no icon dependency.
- A fixed section taxonomy — `groupBy` is a hook; the shipped default groups
  by `NodeType` in `NODE_TYPE` enum order.
- Hardcoded catalog rows or provider entries of any kind — the catalog is
  always consumer-supplied data.
- Any non-English default string set — `strings` + `DEFAULT_PALETTE_STRINGS`,
  matching `BuilderStrings`/`DEFAULT_STRINGS`'s existing convention
  (`packages/react/src/types.ts:41-55`).
- A tool hover card / expanded-description surface — see [Seam completeness
  (b)](#seam-completeness-four-open-questions).

Example custom MCP-provider grouping (documents the seam, not shipped):

```ts
import type { McpNodeSpecMeta } from '@openpipeline/core';

function groupByMcpProvider(catalog: NodeSpecDescriptor[]): PaletteSection[] {
  const byProvider = new Map<string, NodeSpecDescriptor[]>();
  const rest: NodeSpecDescriptor[] = [];
  for (const spec of catalog) {
    const mcp = spec.meta?.mcp as McpNodeSpecMeta | undefined;
    if (spec.nodeType === 'MCP_TOOL' && mcp) {
      const list = byProvider.get(mcp.providerKey) ?? [];
      list.push(spec);
      byProvider.set(mcp.providerKey, list);
    } else {
      rest.push(spec);
    }
  }
  const sections: PaletteSection[] = [{ id: '_core', label: 'Core', specs: rest }];
  for (const [key, specs] of byProvider) {
    const firstMeta = specs[0]?.meta?.mcp as McpNodeSpecMeta | undefined;
    sections.push({ id: key, label: firstMeta?.providerDisplayName ?? key, specs });
  }
  return sections;
}
```

**Coupled change:** `BuilderCanvas` needs a drop-target handler to consume
`OPENPIPELINE_NODE_MIME` payloads — and this *does* require a new prop, not
just internal wiring. `NodeDragPayload` is deliberately minimal (`{ key,
nodeType }`, see above), but `store.addNode` takes a complete `BuilderNode`
— `id`, `nodeType`, `key`, `label`, `inputs`, `positionX`/`positionY`
(`packages/react/src/types.ts:4-12`, `packages/react/src/store/
builder-store.ts:59`). `BuilderCanvas` cannot mint `id`/`label` from a
`{ key, nodeType }` payload alone, so it cannot call `store.addNode(...)`
itself. Decision (picking one of three materially different designs, not
leaving it open):

```ts
export interface BuilderCanvasProps {
  // ...existing props unchanged...
  /**
   * Drop-target callback for a NodePalette drag payload. BuilderCanvas
   * decodes `OPENPIPELINE_NODE_MIME` off the drop event and converts the
   * drop's screen coordinates to flow coordinates itself
   * (`useReactFlow().screenToFlowPosition({ x: event.clientX, y:
   * event.clientY })` — BuilderCanvas already runs inside the consumer's
   * `<ReactFlowProvider>`, per its existing usage note). It does **not**
   * call `store.addNode(...)` itself: the consumer mints `id`/`label`/
   * `inputs` here and calls `store.addNode(...)`, mirroring exactly how
   * `onAddNode`'s click-to-add path already works
   * (`examples/playground/src/App.tsx:115-126`: `id:
   * crypto.randomUUID()`, `label: spec.displayName`) — same pattern, now
   * also triggered by a drop. Not called, and the drop is not decoded at
   * all, when `editable` is `false` — same gate every other mutation goes
   * through (`onConnect`/`onNodesChange`/`onEdgesChange`,
   * `BuilderCanvas.tsx:209-214`).
   */
  onNodeDrop?: (payload: NodeDragPayload, position: { x: number; y: number }) => void;
}
```

This is additive (`onNodeDrop` is optional — a consumer that doesn't pass it
gets today's exact behavior, no drop handling at all) but it **is** a real
props addition, correcting an earlier draft of this section that implied
none was needed. Two alternatives were considered and rejected: (1) a new
`catalog?: NodeSpecDescriptor[]` prop letting `BuilderCanvas` resolve
`label` itself — rejected because it duplicates catalog data the consumer
already holds for the palette, and couples `BuilderCanvas` to
`NodeSpecDescriptor` lookups it doesn't otherwise need; (2) `BuilderCanvas`
mints `label = payload.key` and a `crypto.randomUUID()` id internally with
no new prop — rejected as the cheapest but worst option: it bakes a
UX/labeling policy (raw `key` as the visible label) into the library instead
of letting the consumer decide, the one thing this package's conventions
consistently avoid elsewhere (i18n `strings`, `renderIcon`, `groupBy`,
`getSlotVisibility` are all consumer hooks for exactly this reason). The
`onNodeDrop` callback (chosen above) matches this package's
controlled-component convention — consumer owns node construction, same as
`onAddNode` — and requires zero new state inside `BuilderCanvas`.

---

### 2. `InspectorPanel`

The core design: the inspector is a pure JSON-Schema-driven form generator —
`Object.keys(unwrapJsonSchema(spec.inputSchema).properties ?? {}).map(paramName => <SlotField .../>)`.
`InspectorPanel` calls `unwrapJsonSchema` (defined in [Shared type
additions](#shared-type-additions)) on `spec.inputSchema` itself,
internally, before the render loop runs — a consumer handing in a raw
`z.toJSONSchema()`/`zodToJsonSchema()` result, root-`$ref`-wrapped or not,
gets a correctly populated form either way. This render loop needs no
product-specific logic at all — every per-node/per-model exception is
pushed out to `getSlotVisibility` (below), not hardcoded here.

```ts
export interface InspectorPanelProps {
  /** `null` renders the panel's empty state (no node selected). */
  node: BuilderNode | null;
  /** Catalog lookup by `node.key` — done by the consumer, same as every other prop in this component; `InspectorPanel` never owns catalog data. */
  spec: NodeSpecDescriptor | undefined;
  onLabelChange: (label: string) => void;
  onBindingChange: (paramName: string, binding: ValueBinding) => void;
  onBindingClear: (paramName: string) => void;
  /**
   * Pre-built ancestor state-path roots for the "state" binding kind's
   * picker. See `StatePathPicker` below for how a consumer builds this from
   * `nodes`/`edges`/the catalog — kept as a prop here (not computed inside
   * InspectorPanel) so InspectorPanel itself never needs a runtime
   * `@openpipeline/core` import; only `StatePathPicker` does. See
   * [Ancestor computation and the package
   * boundary](#ancestor-computation-and-the-package-boundary).
   */
  stateRoots: StatePathRoot[];
  /** Per-slot validation errors, pre-filtered to this node by the consumer — a prop, not a store read, matching every other input here. */
  errors?: SlotValidationError[];
  /**
   * Pluggable visibility/disable/enum-narrowing hook. Defaults to
   * always-visible/always-enabled. Deliberately **not** a hardcoded
   * per-node-type switch — a consumer with a per-model or per-tool
   * capability matrix supplies this themselves.
   */
  getSlotVisibility?: (ctx: {
    nodeKey: string;
    slotName: string;
    inputs: NodeInputs;
    meta?: Record<string, unknown>;
  }) => SlotVisibility;
  strings?: Partial<InspectorStrings>;
  className?: string;
  style?: React.CSSProperties;
}

export interface SlotValidationError {
  paramName: string;
  message: string;
}

export interface SlotVisibility {
  visible: boolean;
  disabled: boolean;
  reason?: string;
  /** Narrows an enum schema's allowed values at render time without mutating the catalog's static schema. */
  filteredEnum?: unknown[];
}

export interface InspectorStrings {
  labelPlaceholder: string;
  requiredBadge: string;
  unsupportedBadge: string;
  kindLiteral: string;
  kindState: string;
  kindAuto: string;
  clearBinding: string;
  emptySelection: string;
  jsonParseError: string;
}
```

**`SlotField`** (also exported standalone — the single most reusable
primitive in this surface, since it depends only on a schema and a binding,
never on graph or catalog state):

```ts
export interface SlotFieldProps {
  nodeKey: string;
  paramName: string;
  propSchema: SlotJsonSchema;
  isRequired: boolean;
  binding: ValueBinding | undefined;
  visibility?: SlotVisibility;
  errors?: readonly string[];
  onBindingChange: (binding: ValueBinding) => void;
  onBindingClear: () => void;
  /** Opens the picker for the "state" kind — supplied by InspectorPanel, or directly by a consumer using SlotField standalone. */
  renderStatePicker?: (props: { current?: StateValueBinding; onChange: (b: StateValueBinding) => void }) => React.ReactNode;
  strings?: Partial<InspectorStrings>;
}
```

**Editor-mapping table** — dispatches on `SlotJsonSchema` shape, never live
zod, since `@openpipeline/react` never holds a zod instance. Before any of
the rows below apply, `SlotField` calls `unwrapNullableUnion(schema)` (see
[Shared type additions](#shared-type-additions)): an `anyOf`/`oneOf` with
exactly one non-`null` variant is replaced by that variant, so
`z.number().nullable()`'s `{ anyOf: [{ type: 'number' }, { type: 'null' }] }`
dispatches as `type: 'number'`, not as the union catch-all row. Only a union
with more than one non-null variant (a genuine sum type) falls through to
the `anyOf`/`oneOf` catch-all row below:

| `SlotJsonSchema` shape (after `unwrapNullableUnion`) | Editor | Notes |
|---|---|---|
| `enum` present (any type) | `<select>` + blank "— choose —" option | Checked before type dispatch — an enum of numbers still gets a select |
| `type: 'boolean'` | Checkbox | |
| `type: 'number' \| 'integer'` | Number input, `min`/`max` from `minimum`/`maximum`, placeholder from `default` | |
| `type: 'array' \| 'object'` | JSON textarea — parses on change, commits the **parsed value** (never the raw string) on success, shows inline parse errors | See the coercion note below |
| everything else (`string`, unknown, a genuine multi-variant `anyOf`/`oneOf`) | Text input, `<datalist>` from `examples`, `minLength`/`maxLength` wired | A multi-variant union still falls here — no per-variant editor is speced for 0.6.0, see [allOf handling](#seam-completeness-four-open-questions) for the related `allOf` limitation |

**Shared coercion/default utilities — exported standalone, not buried in
`SlotField`.** Both functions below share one internal per-type table —
`literalDefaultForType` — so "what's the safe default/fallback value for
this schema type" is answered in exactly one place, not duplicated between a
default-picker and a coercer. Both also call `unwrapNullableUnion` first, so
a nullable slot's default/coercion follows its real (non-null) type, not the
union catch-all:

```ts
// packages/react/src/lib/binding-defaults.ts

/**
 * The one per-type default/fallback table `defaultBindingForKind`'s `literal`
 * branch and `coerceLiteralToSchemaType` both build on. Not exported — an
 * implementation detail both public functions share so the table exists in
 * exactly one place. Calls `unwrapNullableUnion(schema)` first. `0` for
 * number/integer, `false` for boolean, `[]` for array, `{}` for object,
 * `null` for `type: 'null'`, `''` otherwise.
 */
function literalDefaultForType(schema: SlotJsonSchema): unknown { /* calls unwrapNullableUnion(schema) first, then switches on schema.type — see table above */ }

/**
 * A type-appropriate default binding for `kind`, given a slot's schema.
 *
 * `literal` MUST NOT default every literal to `''` — a string default fails
 * zod validation for every object/array slot (`string ≠ object`), silently
 * turning "pick a kind" into "pick a kind and then fix the type error it
 * just caused." Returns `{ kind: 'literal', value:
 * literalDefaultForType(schema) }`.
 *
 * `auto` always returns `{ kind: 'auto' }`.
 *
 * `state` returns `undefined` — **not** a `StateValueBinding`, and this is a
 * deliberate, load-bearing decision, not an omission. There is no
 * OpenPipeline default state path to seed one from: `{ path: '' }` is not a
 * legal placeholder either — it fails `validateStatePath` (`INVALID_LENGTH`)
 * and `StateValueBindingSchema` (`packages/core/src/value-binding.ts:31-34`,
 * `z.string().min(1)`), so it cannot even be persisted. Seeding from the
 * first available `StatePathRoot` leaf instead was considered and rejected:
 * it would silently wire the slot to an arbitrary upstream field the user
 * never chose — a more dangerous default than leaving the slot unbound —
 * and `defaultBindingForKind` would need `StatePathRoot[]` threaded into
 * every call site (including ones that never open the picker) to do it. See
 * "Kind-switching commit flow" below for what the caller does with an
 * `undefined` result.
 */
export function defaultBindingForKind(kind: ValueBinding['kind'], schema: SlotJsonSchema): ValueBinding | undefined;

/**
 * Coerces a value (a JSON-editor's parsed value, or any literal-editor's raw
 * `onChange` value) to match the slot's declared JS type before it becomes a
 * literal binding. A raw textarea string committed directly as an
 * array/object binding breaks MCP zod validation downstream with "expected
 * array, received string" — the second shape the same underlying bug class
 * takes (the first is `defaultBindingForKind`'s all-`''`-defaults case
 * above). This utility is the structural fix — every literal-editor call
 * site MUST route through it, so this bug class cannot recur per-integrator.
 * Calls `unwrapNullableUnion(schema)` first, so a nullable slot is coerced
 * against its real type, not the union catch-all.
 *
 * **Un-coercible branch, fully defined — this is what makes the structural
 * fix actually complete, not just the happy path**: when `value`'s runtime
 * type doesn't structurally match `schema.type` — a JSON-parsed string or
 * number handed to an `object`/`array` slot, or a non-finite `number` result
 * (e.g. `Number('')` or `Number('abc')` producing `NaN`) — this function
 * substitutes `literalDefaultForType(schema)`, the exact same table
 * `defaultBindingForKind`'s `literal` branch uses. It never throws and never
 * passes the mismatched value through unconverted. Both are deliberate:
 * every call site is a synchronous `onChange` firing on each keystroke/paste,
 * so throwing here would crash the render loop mid-edit rather than reject
 * one commit; and passing the mismatched value through is exactly the bug
 * class this function exists to make structurally impossible — an "escape
 * hatch" branch would reopen it. Per-type check: `number`/`integer` valid
 * iff `typeof value === 'number' && Number.isFinite(value)`; `boolean`
 * valid iff `typeof value === 'boolean'`; `array` valid iff
 * `Array.isArray(value)`; `object` valid iff `typeof value === 'object' &&
 * value !== null && !Array.isArray(value)`; `type: 'null'` valid iff `value
 * === null`; everything else (`string`, no declared type, a genuine
 * multi-variant `anyOf`/`oneOf`) valid iff `typeof value === 'string'`.
 * Note `defaultBindingForKind('literal', schema)` is definitionally
 * `{ kind: 'literal', value: coerceLiteralToSchemaType(undefined, schema) }`
 * — `undefined` fails every validity check above, so it always falls
 * through to `literalDefaultForType(schema)`. The two functions are the
 * same table, entered from two different call sites.
 */
export function coerceLiteralToSchemaType(value: unknown, schema: SlotJsonSchema): unknown;
```

**Kind-switching commit flow — resolves what an implementer needs to write
the pill switcher**: clicking a kind pill (`literal`/`state`/`auto`) inside
`SlotField` calls `defaultBindingForKind(kind, schema)`.

- `literal`/`auto` — the result is always a defined `ValueBinding`.
  `SlotField` commits it immediately via `onBindingChange`.
- `state` — the result is `undefined` by design (see above). `SlotField`
  does **not** call `onBindingChange` on the click. It only opens the state
  picker (calls `renderStatePicker`) and leaves whatever binding was
  already there (or the unset state, if none) untouched until the user
  actually picks a leaf — at which point `StatePathPicker.onChange` commits
  the first real `StateValueBinding` for that slot. This is deliberately
  asymmetric with `literal`/`auto`, which commit their default the moment
  the pill is clicked: `state` has no safe default to commit, so it doesn't
  commit one.

**Slot status** — a pure, exported function over 5 states, with one Phase 1
simplification stated explicitly rather than silently:

```ts
// packages/react/src/inspector/slot-status.ts
export type SlotStatus =
  | 'empty_required'
  | 'unset_optional'
  | 'explicit'
  | 'auto'
  | 'auto_unreachable';

/**
 * Phase 1 simplification, stated explicitly rather than silently:
 * `isReachable` is not computed by this spec — an `auto` binding is always
 * treated as reachable, so `auto_unreachable` is defined but currently
 * unreachable in practice. Real reachability analysis (does *any* node type
 * in the catalog actually produce this output shape) is a tracked
 * follow-up — see [Phase 3 item 8](#phased-implementation-plan), not an
 * oversight.
 */
export function computeSlotStatus(args: {
  binding: ValueBinding | undefined;
  isRequired: boolean;
  isReachable?: boolean; // defaults to true
}): SlotStatus;
```

**Presentation**: required badge (rose), unsupported/disabled badge (amber),
the disabled-slot ordering rule stated explicitly — `visibility.reason`
renders **before** the description text, so a disabled slot's *reason* is
the first thing a user reads, not the last — a native `disabled` fieldset
wrapping the binding editor when `visibility.disabled` (belt-and-suspenders
semantic disable, on top of the visual disabled state), and a reset/clear
affordance calling `onBindingClear`.

**Out of scope:**

- Any built-in global-store reads — every input above is a prop;
  `InspectorPanel` owns no state of its own beyond internal UI state (which
  pill/section is expanded).
- Any hardcoded per-node-type visibility switch — only the
  `getSlotVisibility` hook shape ships; the logic behind it is always the
  consumer's.
- A new color palette — inline styles reuse the same neutral palette
  already established in `PipelineNodeCard`
  (`packages/react/src/canvas/PipelineNodeCard.tsx`: `#6366f1` indigo,
  `#94a3b8` slate, `#ef4444` rose, `#10b981` emerald, `#f59e0b` amber).
- Any non-English default string set — `InspectorStrings` + English
  defaults, `strings` prop for i18n.

---

### 3. `StatePathPicker`

The "reference another node's output" picker. This is the component the
[package-boundary decision](#ancestor-computation-and-the-package-boundary)
below is actually about: it is the one piece of the builder kit that needs
to know the graph's topology (which nodes are upstream of the one being
edited), not just the shape of a single node's schema.

```ts
export interface StatePathRoot {
  /** A node id, or the synthetic id of the one built-in non-node root (`'_meta'` — see "Building `roots`" below). */
  id: string;
  label: string;
  leaves: StatePathLeaf[];
}

export interface StatePathLeaf {
  /**
   * Already fully qualified, e.g. `outputs.<nodeId>.field` or `meta.userId`
   * — ready to drop straight into a `StateValueBinding.path`. MUST pass
   * `validateStatePath` from `@openpipeline/core` (`packages/core/src/
   * path-validator.ts`) — the same grammar `StateValueBinding.path` is
   * documented to require (`packages/core/src/value-binding.ts:16`) and
   * that `packages/nodes/src/value-binding-resolver.ts:60` enforces at run
   * time, throwing on a violation. `buildStatePathTree` (below) guarantees
   * this by construction: it never emits a leaf whose `path` fails
   * `validateStatePath`.
   */
  path: string;
  label: string;
  schema?: SlotJsonSchema;
}

export interface StatePathPickerProps {
  roots: StatePathRoot[];
  targetSchema?: SlotJsonSchema;
  current?: StateValueBinding;
  onChange: (binding: StateValueBinding) => void;
  strings?: Partial<StatePathPickerStrings>;
}

export interface StatePathPickerStrings {
  searchPlaceholder: string;
  noAncestors: string;
  noMatches: string;
  incompatibleTooltip: string;
  uncertainCompatBadge: string;
}
```

**Building `roots`** — a pure, exported utility. The design question this
section resolves: does a picker offer a synthetic root for *arbitrary*
graph-level input (a consumer-supplied `opts.graphInputSchema` describing
whatever shape their graph's run input takes), or only for the run-state
OpenPipeline itself actually populates? The answer is the latter, because
OpenPipeline has nothing for a free-form root's leaves to resolve against:
`PipelineState` (`packages/core/src/state.ts:106-112`) has exactly five
channels — `meta`, `outputs`, `nodeMeta`, `cost`, `events` — `PipelineMeta`
itself (`state.ts:23-40`) is a **closed** shape (`runId`, `pipelineId`,
`pipelineName`, `pipelineDescription`, `deliveryMode`, `context?:
{ userId?, tenantId?, getOAuthToken? }`, `mcpCatalogCache?`), not a
free-form host payload, and `RunOptions`
(`packages/runtime/src/index.ts:108-123`) accepts no consumer-supplied
graph-level run input at all — only `context`. A leaf path like `query` is
not blocked by anything: it **passes** `validateStatePath` (the grammar
only checks characters/length/depth, never whether a path resolves to
anything) and then silently resolves to `undefined` via `getByPath` at run
time — no throw, no validation error, no UI signal. Accepting a
consumer-supplied `graphInputSchema` would let a picker manufacture exactly
that failure mode by construction.

Instead, `buildStatePathTree` emits one **built-in, statically-defined**
`meta` root — grounded in `PipelineMeta`'s actual fields, the only part of
`PipelineState` a graph-level (non-node-output) reference can resolve
against today — plus one `outputs.<nodeId>.` root per ancestor:

```ts
// packages/react/src/lib/state-path-tree.ts

export interface AncestorForPicker {
  id: string;
  label: string;
  outputSchema?: SlotJsonSchema;
}

/**
 * The built-in `meta` root's schema. Statically mirrors `PipelineMeta`
 * (`packages/core/src/state.ts:23-40`) — **not** a consumer-supplied schema,
 * because `PipelineMeta` is closed and populated entirely by the runtime at
 * run start. `mcpCatalogCache` (an opaque runtime cache, typed `unknown[]`)
 * and `context.getOAuthToken` (a function, not state data) are excluded;
 * every other field is a plain string, so no coercion ambiguity exists here.
 */
const META_ROOT_SCHEMA: SlotJsonSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    pipelineId: { type: 'string' },
    pipelineName: { type: 'string' },
    pipelineDescription: { type: 'string' },
    deliveryMode: { type: 'string' },
    context: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        tenantId: { type: 'string' },
      },
    },
  },
};

/**
 * Walks each ancestor's `outputSchema` into a `StatePathRoot` (objects
 * become expandable branches, arrays get a synthetic `[0]` index child,
 * primitives become leaves), and — unless `opts.includeMetaRoot === false`
 * — prepends one built-in root (id `'_meta'`) walked from `META_ROOT_SCHEMA`
 * above with a `meta.` path prefix. There is no `graphInputSchema` option:
 * see the note above this code block for why a consumer-supplied
 * graph-level root has no OpenPipeline run state to ground it in. Each
 * `outputSchema` (and `META_ROOT_SCHEMA`) is passed through
 * `unwrapJsonSchema` before walking — the same root-`$ref` wrapper problem
 * `InspectorPanel` solves for `inputSchema` applies identically to
 * `outputSchema` here; this is the second of two call sites that would
 * otherwise each need their own root-unwrap logic, unified onto the single
 * `unwrapJsonSchema` defined in [Shared type additions](#shared-type-additions).
 * During the walk, each property's schema is also passed through
 * `unwrapNullableUnion` before its `type` is inspected, so a nullable
 * ancestor-output field resolves to its real type's leaf instead of the
 * union catch-all — the same collapse `SlotField`'s editor dispatch applies.
 *
 * Phase 1 simplifications, stated explicitly rather than silently:
 * `oneOf`/`anyOf` walk only the first variant for a genuine multi-variant
 * union (a nullable field, per `unwrapNullableUnion`'s single-non-null
 * collapse, still resolves to one typed leaf and doesn't hit this
 * limitation); nested schemas deeper than 1 level fall back to an
 * "uncertain, shown anyway" leaf rather than being rejected; a nested
 * (non-root) `$ref` is not dereferenced, same documented limitation as
 * `unwrapJsonSchema` itself; and per [allOf
 * handling](#seam-completeness-four-open-questions), an `allOf`-combined
 * schema is not merged and falls to the same "uncertain, shown anyway"
 * leaf. Carried forward as a stated Phase 1 limitation, not silently
 * narrower behavior.
 *
 * **Grammar enforcement**: every constructed leaf path — both
 * `outputs.<nodeId>.<field>` from the ancestor walk *and* `meta.<field>`
 * from the built-in root — is validated with `validateStatePath` from
 * `@openpipeline/core` (already a `dependencies` entry of
 * `@openpipeline/react` — zero added cost) before it is emitted as a
 * `StatePathLeaf`. A field name that fails the grammar — contains a
 * character outside `PATH_REGEX`
 * (`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+|\.?\[\d+\])*$`), is a
 * `FORBIDDEN_SEGMENTS` entry (`constructor`, `prototype`, `__proto__`,
 * …), or would push the path past `MAX_PATH_DEPTH`/`MAX_PATH_LENGTH` — is
 * **dropped from the tree** rather than emitted as an unusable leaf,
 * because `value-binding-resolver.ts:60` throws on it at run time; a
 * picker that let a user select it would produce a binding that only fails
 * later, off-screen, at run time. `META_ROOT_SCHEMA`'s own field names are
 * chosen to already satisfy the grammar, but the filter still runs over
 * them — defense-in-depth against a future edit to that schema silently
 * introducing an ungrammatical leaf.
 */
export function buildStatePathTree(
  ancestors: readonly AncestorForPicker[],
  opts?: { includeMetaRoot?: boolean }
): StatePathRoot[];

/**
 * Fallback-biased compatibility check between a candidate leaf's schema and
 * a target slot's schema: depth-limited, refinements/format/pattern
 * ignored, nullable is always fallback-compatible, and a provably
 * incompatible property is never masked by a later fallback-compatible one
 * in the same object. `fallback: true` means "shown but marked uncertain,"
 * never "hidden" — a strict rejector would be too aggressive against real
 * catalog schemas that don't round-trip perfectly through a JSON Schema
 * converter.
 */
export function checkStatePathCompat(
  leafSchema: SlotJsonSchema | undefined,
  targetSchema: SlotJsonSchema | undefined
): { compatible: boolean; fallback: boolean };
```

**Getting the ancestor list itself** is the consumer's call, using
`computeAncestors` from `@openpipeline/core` (already a dependency of
`@openpipeline/react` — see [Ancestor computation and the package
boundary](#ancestor-computation-and-the-package-boundary)):

```tsx
import { computeAncestors } from '@openpipeline/core';
import { buildStatePathTree, StatePathPicker } from '@openpipeline/react';

function useAncestorRoots(
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  selfNodeId: string,
  byKey: Map<string, NodeSpecDescriptor>
) {
  return useMemo(() => {
    const graph = new Map<string, { predecessors: string[]; successors: string[] }>(
      nodes.map((n) => [n.id, { predecessors: [], successors: [] }])
    );
    for (const e of edges) {
      graph.get(e.source)?.successors.push(e.target);
      graph.get(e.target)?.predecessors.push(e.source);
    }
    const ancestorIds = computeAncestors(selfNodeId, graph);
    const ancestors = ancestorIds.map((id) => {
      const n = nodes.find((x) => x.id === id)!;
      return { id, label: n.label, outputSchema: byKey.get(n.key)?.outputSchema };
    });
    return buildStatePathTree(ancestors);
  }, [nodes, edges, selfNodeId, byKey]);
}
```

This type-checks against data `@openpipeline/react` actually holds in the
browser — plain `BuilderNode`/`BuilderEdge` objects — because
`computeAncestors`'s accepted parameter type is widened for this spec (see
[Phase 2 step 5](#phased-implementation-plan)) to only the two fields the
function's own implementation ever reads (`predecessors`/`successors`),
rather than the full `CompiledNode` shape (which requires a live zod
`NodeSpec` and a `PipelineNodeRow.pipelineId`, neither available in the
browser — see "Current-state facts" above). (A convenience wrapper that
builds this predecessor/successor map from `nodes`/`edges` directly —
`computeStatePathRoots(nodes, edges, selfNodeId, byKey)` — is worth adding
once real usage confirms the ergonomics; see [Phase 3 item
9](#phased-implementation-plan).)

**In scope**: the two-root-kind pattern (one built-in `meta` root + N
upstream-node roots — see above for why the `meta` root is statically
grounded rather than a generalized synthetic graph-input root); the
`outputs.<nodeId>.` path prefix convention, matching `PipelineState`'s own
`outputs` channel name (`packages/core/src/state.ts:106-112`) — this is
OpenPipeline's own state shape; ancestors-only filtering (topological
ancestors, never descendants or siblings — directly enforces "you can only
reference upstream output" at the UI layer, the same rule
`graph-validator.ts:274-279`'s `REF_NOT_PREDECESSOR` enforces at validation
time); search with force-expand-matching-branches; distinct "first node, no
ancestors" vs "search has no matches" empty states; a fallback-compat `~`
badge for a leaf whose schema is only uncertainly compatible with the
target slot; and the `current` prop's behavior — see [Seam completeness
(c)](#seam-completeness-four-open-questions) for exactly what it does.

**The path grammar this picker's output must satisfy — owned by
`@openpipeline/core`, not by this kit**: `validateStatePath`
(`packages/core/src/path-validator.ts`) is the grammar every
`StateValueBinding.path` — including every path this picker produces — is
documented to satisfy (`packages/core/src/value-binding.ts:16`) and is
enforced against at run time (`packages/nodes/src/value-binding-resolver.ts:60`,
throws on a violation). `buildStatePathTree` cites and enforces it (see
above) for both root kinds — a node's `outputSchema` property named
`constructor`, containing a `.` or a space, or nested past
`MAX_PATH_DEPTH` (16) never reaches the picker as a selectable leaf, and
neither does a `META_ROOT_SCHEMA` field that somehow failed the same check.
This removes an entire class of "the picker produced a binding that
explodes at run time, off-screen" bug, since a picker that let a user
select an ungrammatical leaf would otherwise produce exactly that.

**Out of scope**: a consumer-supplied `opts.graphInputSchema` describing an
arbitrary graph-level input shape — see "Building `roots`" above for why
(no OpenPipeline run-state channel exists for such a schema to describe).
The only non-node-output root is the built-in `meta` root, statically
grounded in `PipelineMeta`. A real free-form, consumer-supplied
graph-level run-input channel is tracked as a follow-up engine decision,
not solved here — see [Explicit non-goals](#explicit-non-goals).

---

### 4. `ValidationDisplay`

```ts
/**
 * The minimal shape `ValidationDisplay` actually renders — deliberately
 * looser than `GraphValidationIssue` so two structurally different sources
 * both satisfy it without a cast:
 *
 * - `GraphValidationIssue` (`packages/nodes/src/graph-validator.ts:11-22`,
 *   `{ code, nodeId?, slot?, message }`) — its `code` union is a subtype of
 *   `string`, so it is assignable here with no adapter and no import.
 * - `CompileErrorEntry` (`packages/core/src/errors.ts:4-20`,
 *   `{ scope, kind, message, nodeId?, nodeKey? }`) from a caught
 *   `PipelineCompileError` — the only validation the shipped stack performs
 *   today, thrown inside `engine.run()` -> `PipelineCompiler.compile()`
 *   (`packages/nodes/src/compiler.ts:87-95, 127-140, 191-199`) — via the
 *   `compileErrorEntriesToIssueViews` adapter below.
 *
 * `code` is typed `string`, not `GraphValidationIssue['code']`'s closed
 * union: `CompileErrorEntry.kind` includes `TOPOLOGY_NO_ENTRY` and
 * `IF_MISSING_BRANCH`, thrown directly by the compiler outside
 * `validateGraph` (`compiler.ts:87-95, 191-199`), so it is a strict
 * superset of `GraphValidationIssue['code']`, not the same closed set.
 */
export interface DisplayableValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  slot?: string;
}

export interface ValidationIssueView {
  issue: DisplayableValidationIssue;
  /** Explicit per-issue tone, assigned by the consumer rather than inferred — neither `GraphValidationIssue` nor `CompileErrorEntry` carries a provenance field (see "Current-state facts" above and `compileErrorEntriesToIssueViews` below), so there is nothing on the issue shape itself to key a tone off of. */
  tone: 'advisory' | 'blocking';
}

export interface ValidationDisplayProps {
  issues: ValidationIssueView[];
  /** Optional advisory-only supplementary notices (e.g. a planner's non-blocking warnings). Rendered in a visually separate section, uncapped, never mixed into the errors list. */
  advisoryNotes?: string[];
  defaultCollapsed?: boolean;
  strings?: Partial<ValidationDisplayStrings>;
  className?: string;
  style?: React.CSSProperties;
}

export interface ValidationDisplayStrings {
  errorCountLabel: (n: number) => string; // e.g. n => `${n} error${n===1?'':'s'}`
  advisoryHeadline: (n: number) => string;
  expand: string;
  collapse: string;
  moreErrors: (n: number) => string;
}
```

**Why `tone` is a prop the consumer assigns, not a field `ValidationDisplay`
infers**: this is forced by the actual type shapes, not a stylistic choice —
`GraphValidationIssue` genuinely has no provenance field to key off
(confirmed above), so an arbitrary tone/severity mapping the consumer
assigns per issue is the only generalization that fits every real source. A
typical mapping is one line: issues from a compile failure → `'blocking'`;
issues still present in a planner's `unresolvedValidationErrors` on an
auto-generated draft → `'advisory'`. `ValidationDisplay` never has to know
*why* an issue has the tone it has — it only renders; it never mutates the
`issues` array it's handed.

**In scope**: a two-tone color system (amber = advisory, rose = blocking,
reusing this kit's existing `#f59e0b`/`#ef4444` from `PipelineNodeCard`'s
status palette, not new hex); headline+summary composition (`N errors` /
first message + "and N more"); collapsed-vs-expanded with a 5-item cap on
errors and an uncapped advisory-notes section, visually separated when both
are present; documenting any defensive branch that is currently
unreachable given today's inputs (e.g. `auto_unreachable` above) as a code
comment for future maintainers, rather than deleting the branch or leaving
it unexplained.

**`compileErrorEntriesToIssueViews` — the `PipelineCompileError` ->
`ValidationDisplay` adapter, and `ValidationDisplay`'s *only* workable
input source for 0.6.0.** `validateGraph(graph, specs:
ReadonlyMap<string, NodeSpec>)` (`packages/nodes/src/graph-validator.ts:125-128`)
requires live zod `NodeSpec` objects — the browser, by this spec's own
design, only ever holds `NodeSpecDescriptor` with a JSON-Schema-shaped
`inputSchema`, and an MCP-sourced node's `handler` closes over a
server-side client with no browser equivalent (see "Current-state facts"
above). So a client-side `validateGraph()` call is not a deferred
nice-to-have — it is not implementable against this spec's catalog shape at
all, for any catalog a consumer could supply. And `validateGraph` does not
run on the save path either — `PipelineEngine.save()` is `return
this.store.save(draft);` with no validate call
(`packages/runtime/src/index.ts:276-278`, see [Explicit
non-goals](#explicit-non-goals)). The only place `PipelineCompileError` is
actually thrown in the shipped stack is inside `engine.run()` ->
`PipelineCompiler.compile()`. So the realistic "my `engine.run()` call
threw `PipelineCompileError`, show the user why" wiring is not just *a*
source for `ValidationDisplay` — for 0.6.0 it is the *only* one, and this
adapter is what makes it usable:

```ts
// packages/react/src/validation/adapt-compile-error.ts

/**
 * Adapts a caught `PipelineCompileError`'s `entries` into
 * `ValidationIssueView[]` for `ValidationDisplay`.
 *
 * Every entry gets `tone: 'blocking'`, unconditionally: a
 * `PipelineCompileError` means the graph did not compile at all, so there
 * is no "advisory, might still run" reading of it — contrast a planner's
 * `unresolvedValidationErrors` on an auto-generated draft, which
 * legitimately can be `'advisory'`.
 *
 * Field mapping: `entry.kind` -> `issue.code`, `entry.message` ->
 * `issue.message`, `entry.nodeId` -> `issue.nodeId`. `issue.slot` is always
 * `undefined` — `CompileErrorEntry` has no slot-level granularity.
 * `entry.scope` (`'graph' | 'node'`) and `entry.nodeKey` are intentionally
 * dropped, not carried onto an unused field: `DisplayableValidationIssue`
 * has no `scope`/`nodeKey` slot, `ValidationDisplay`'s rendering (tone +
 * headline/summary composition, see "In scope" above) doesn't need either,
 * and adding fields for a hypothetical future consumer need is exactly the
 * kind of over-generalization this document is otherwise careful to avoid
 * (see `StatePathPicker`'s `opts.graphInputSchema` walk-back above). A
 * consumer that wants `scope`/`nodeKey` for its own rendering still has the
 * original `entries` array; this adapter doesn't have to be the only thing
 * that ever looks at it.
 */
export function compileErrorEntriesToIssueViews(
  entries: readonly CompileErrorEntry[]
): ValidationIssueView[];
```

**Prune-on-fix — a pure exported utility, not store-side logic**:
`@openpipeline/react`'s `createBuilderStore` deliberately does not own
validation state (`packages/react/src/store/builder-store.ts` has no
`validation` field) — that split is intentional and pre-existing, not
something this spec introduces. So symmetric pruning (drop an issue once
its cause is fixed) becomes a pure function the consumer calls from their
own `onBindingChange`/`onRemoveNode` handlers, wiring the two
separately-owned pieces of state together themselves:

```ts
// packages/react/src/validation/prune.ts

/**
 * A pure function with two prune triggers: drop any issue scoped to a slot
 * that was just (re)bound, and drop any issue scoped to a node that was
 * just removed. Only applies to issues the consumer marks prunable
 * (typically `tone: 'advisory'` ones — a `'blocking'` issue from a compile
 * failure should stay until the next real re-validation runs; this
 * function is an optimistic UX signal, not a substitute for
 * re-validating).
 */
export function pruneResolvedIssues(
  issues: ValidationIssueView[],
  change: { fixedNodeId?: string; fixedParamName?: string } | { removedNodeId: string }
): ValidationIssueView[];
```

**Out of scope**: any non-English default string set — `strings` +
formatter functions (`errorCountLabel(n)`, etc.) so pluralization isn't
hardcoded to English's rules either; inferring `tone` from any field on the
issue itself — no such field exists on `GraphValidationIssue` or
`CompileErrorEntry` (see above), so this is not a future enhancement, it is
not representable by today's types.

---

## Seam completeness: four open questions

Four behaviors surfaced during review as neither clearly in scope nor
declared out of scope. Each gets one explicit decision here.

**(a) Per-MCP-provider tool-compatibility summary (the "N unsupported"
pill).** **In scope**, with a contract addition:
`NodePaletteProps.providerCompat` (see [`NodePalette`](#1-nodepalette)).
This isn't a hypothetical surface — OpenPipeline's own MCP resolver already
computes the underlying fact server-side
(`packages/mcp/src/node-resolver.ts:90-93` emits
`NODE_MCP_SCHEMA_INCOMPATIBLE` for any tool whose schema doesn't convert to
zod, and excludes it from the catalog silently), so a palette section with
fewer tools than the provider actually exposes, and no visible explanation,
is a real gap this kit should close.

**(b) A tool hover card with an expanded, formatted description.** **Out of
scope** for 0.6.0. Consequence: `NodePalette` renders each catalog entry's
`description` as plain text, CSS-truncated where it doesn't fit, with the
browser's native `title` attribute as the only affordance for reading the
rest. No markdown rendering, no popover, no SSR-hydration-safe two-pass
render is speced. Tracked as a candidate Phase 3 addition once real usage
shows plain-text truncation is insufficient.

**(c) `StatePathPickerProps.current`.** **In scope**, defined precisely:
`current` (the slot's existing `StateValueBinding`, if any) is used only to
determine which leaf renders as selected/active in the tree.
`StatePathPicker` compares `current.path` against each `StatePathLeaf.path`
directly — both sides already use the same fully-qualified convention
(`outputs.<nodeId>.field`, `meta.field`), so no prefix-stripping is needed
— and auto-expands the ancestor branch containing the match so it's visible
without extra clicks. When no leaf matches (e.g. `current` points at a node
no longer upstream of the one being edited), nothing is marked selected.

**(d) `allOf` schema handling.** **Out of scope**, a declared Phase 1
limitation alongside the existing `oneOf`/`anyOf` first-variant-only rule
(see the [editor-mapping table](#2-inspectorpanel) and `buildStatePathTree`'s
walk). Consequence: an `allOf`-combined schema with no top-level `type`
keyword is not merged into a single effective schema; it falls to the
generic fallback editor in `SlotField` (raw-JSON textarea) and to the
"uncertain, shown anyway" leaf in the ancestor walk. Best-effort
property-union merging is a real future improvement, tracked alongside full
multi-level `$ref` resolution ([Phase 3 item
10](#phased-implementation-plan)), not attempted here.

---

## Ancestor computation and the package boundary

**The question this decomposition raised**: `StatePathPicker` needs
`computeAncestors` at runtime — a real, non-type-only import, the first one
this package would ever make into a runtime graph-algorithm function rather
than a type. Does adding it, plus `ValidationDisplay`'s validation-issue
type, force `@openpipeline/react` to depend on `@openpipeline/nodes` (which
drags in `@langchain/langgraph` as a dependency and `@langchain/core` as a
peer, `packages/nodes/package.json`, neither relevant to a browser-side
picker or display component), or does something need to move first?

**Answer: no boundary change needed.** Working through what each new
component actually requires, by import:

- `StatePathPicker`'s ancestor computation needs `computeAncestors` —
  already in `@openpipeline/core` (`packages/core/src/topology.ts:8,38`),
  already a dependency of `@openpipeline/react`. Nothing to move.
- `ValidationDisplay`'s issue type, `DisplayableValidationIssue`, is
  defined structurally within `@openpipeline/react` itself (see
  [`ValidationDisplay`](#4-validationdisplay)) specifically so that
  `GraphValidationIssue` — wherever a consumer's own code gets one from —
  satisfies it with no adapter and no import. `@openpipeline/react` never
  needs to name `GraphValidationIssue` as a type.
- The compile-error adapter, `compileErrorEntriesToIssueViews`, consumes
  `CompileErrorEntry` — already defined in `@openpipeline/core`
  (`packages/core/src/errors.ts:4-20`), not `@openpipeline/nodes`.
- The one worked example that would have exercised a graph-topology type
  (see [`StatePathPicker`](#3-statepathpicker) above) is written against
  `computeAncestors`'s browser-constructible input directly — plain
  `BuilderNode`/`BuilderEdge` data this package already has, not
  `CompiledNode` (which requires a live zod `NodeSpec` and a
  `PipelineNodeRow.pipelineId`, neither available in the browser — see
  "Current-state facts" above).

So every new runtime dependency this decomposition needs resolves inside
`@openpipeline/core`, which `@openpipeline/react` already depends on today.
There is no code to move, no re-export shim to add, and no new package
dependency to accept. `@openpipeline/nodes`'s own `validateGraph`/
`toCompiledNodeMap`/`GraphValidationIssue` are untouched by this spec —
they stay exactly where they are, since nothing above needs them to move.

The one honest caveat, carried over from `@openpipeline/core`'s own
dependency graph rather than resolved by this decision: `@openpipeline/core`
itself still hard-depends on `@langchain/langgraph` for `state.ts`'s
`PipelineStateAnnotation` (`dependencies`, not `peerDependencies`, and a
real module-eval-time `Annotation.Root(...)` call — confirmed above), so
`@openpipeline/react` depending on `@openpipeline/core` still transitively
installs `@langchain/langgraph` in `node_modules` regardless of anything in
this spec. `@openpipeline/core`'s `"sideEffects": false` declaration and
unbundled per-file ESM output (`packages/core/package.json`) are exactly
what let a modern bundler tree-shake `state.ts`'s code out of a browser
bundle that only imports `computeAncestors`/`errors.ts` — but that is a
property of the bundler and build config, not something this decision
changes either way. Actually eliminating `@langchain/langgraph` from
`@openpipeline/core`'s own dependency list (a peer-dependency conversion,
or splitting `state.ts`'s LangGraph-touching annotation into its own
subpath) is a separate, later decision about `@openpipeline/core` itself —
tracked as [Phase 3 item 7](#phased-implementation-plan), not attempted
here.

---

## Phased implementation plan

**Phase 1 (0.6.0) — validation display + palette**

1. `ValidationDisplay` + `pruneResolvedIssues` + `compileErrorEntriesToIssueViews`,
   exported from `@openpipeline/react`'s `index.ts` alongside
   `DisplayableValidationIssue`/`ValidationIssueView`. No `StatePathPicker`
   dependency — ships first since it only needs `CompileErrorEntry`
   (type-only, from `@openpipeline/core`, matching the package's existing
   type-only-import convention) as a type.
2. `NodePalette` + drag/drop MIME contract + the small additive
   `BuilderCanvas` drop-target change (`onNodeDrop`). Extend
   `NodeSpecDescriptor` with `inputSchema`/`outputSchema` (keep `inputs` as
   deprecated, unused by new code). Add `providerCompat` to
   `NodePaletteProps` (see [`NodePalette`](#1-nodepalette)).
3. **Public-surface additions to `packages/react/src/index.ts`.** Today's
   `index.ts` (`:36-43`) forwards only `BuilderNode`, `BuilderEdge`,
   `NodeSpecDescriptor`, `NodeRunStatus`, `BuilderStrings`,
   `DEFAULT_STRINGS`. The new components' public prop types use
   `ValueBinding`, `StateValueBinding`, `NodeType`, and `NodeInputs`, all of
   which already exist in `packages/react/src/types.ts` but are not
   re-exported from the package entry point — plus every new type this
   spec defines (`SlotJsonSchema`, `StatePathRoot`, `StatePathLeaf`,
   `AncestorForPicker`, `SlotVisibility`, `SlotStatus`,
   `DisplayableValidationIssue`, `ValidationIssueView`,
   `McpProviderCompatSummary`). This is a required step, not a side effect
   of adding the components — listed explicitly so it isn't dropped from
   the plan the way it was from an earlier draft of this section.

**Phase 2 (0.6.0, follows Phase 1) — inspector**

4. `InspectorPanel` + `SlotField` + `lib/json-schema.ts`
   (`unwrapJsonSchema`, `unwrapNullableUnion`) + `binding-defaults.ts` +
   `inspector/slot-status.ts`.
5. `StatePathPicker` + `lib/state-path-tree.ts`, consuming `computeAncestors`
   from `@openpipeline/core` (the *only* new runtime — non-type —
   `@openpipeline/core` import in the package). Widen `computeAncestors`'s
   accepted input type in `@openpipeline/core` from
   `ReadonlyMap<string, CompiledNode>` to
   `ReadonlyMap<string, { predecessors: readonly string[]; successors:
   readonly string[] }>` — the function already only reads those two fields
   off each entry, so this is a structural widening of the accepted
   parameter type, not a behavior change, and every existing caller (which
   passes a map of `CompiledNode`, a subtype of the new parameter type)
   keeps compiling unchanged. This is what makes the worked example in
   [`StatePathPicker`](#3-statepathpicker) above type-check against plain
   `BuilderNode`/`BuilderEdge` data.
6. Wire `examples/playground` end-to-end: replace `App.tsx`'s hand-rolled
   palette buttons with `<NodePalette/>`, add an `<InspectorPanel/>` pane,
   add a `<ValidationDisplay/>` fed from `compileErrorEntriesToIssueViews`
   on a caught `PipelineCompileError` around the playground's `engine.run()`
   call — **this is the only wiring demonstrated, and the only one this
   spec specs.** A client-side `validateGraph()` call before `save()` is
   **not** demonstrated, because it cannot be implemented against this
   spec's catalog shape at all: `validateGraph` requires live zod
   `NodeSpec` objects (`spec.inputSchema instanceof z.ZodObject`, etc. —
   `packages/nodes/src/graph-validator.ts:246,64,249`), and the browser, by
   this spec's own design, only ever holds `NodeSpecDescriptor` with a
   JSON-Schema-shaped `inputSchema` — never a live zod `NodeSpec` — and an
   MCP-sourced node's `handler` closes over a server-side client with no
   browser equivalent regardless of catalog shape. A `<ValidationDisplay/>`
   fed from "the server's rejection response" is equally not demonstrated,
   because that wiring does not exist to demonstrate either:
   `PipelineEngine.save()` is `return this.store.save(draft);` with no
   validate call (`packages/runtime/src/index.ts:276-278`), `savePipeline`
   (`packages/server/src/handlers.ts:99`) just forwards to it, and
   `POST /pipeline` (`packages/server/src/node-http.ts:75`) returns `200`
   unconditionally regardless of graph validity. Making `save()` reject an
   invalid graph is a real engine/server behavior change this spec's own
   non-goals exclude (see below). Update `examples/playground/backend.ts`'s
   catalog to emit real `inputSchema`/`outputSchema` via
   `z.toJSONSchema(spec.inputSchema)` instead of the hand-authored
   flattened `inputs` array. This directly dogfoods the "the playground is
   the reference wrapper to copy" claim already in the README
   (`README.md:362`).

**Phase 3 (0.7.0+, explicit follow-up, not solved by this spec)**

7. Revisit `@openpipeline/core`'s own hard dependency on
   `@langchain/langgraph` (`state.ts`) — evaluate making it a peer
   dependency, or splitting the LangGraph-touching annotation away from the
   pure contract/topology/value-binding types, so a browser bundle that
   only ever imports `computeAncestors`/`errors.ts` has nothing left to
   tree-shake around.
8. Reachability analysis for `SlotStatus`'s `auto_unreachable` state
   (currently hardcoded `isReachable = true`, a stated Phase 1 limitation,
   not fixed here).
9. A convenience `computeStatePathRoots(nodes, edges, selfNodeId, byKey)`
   wrapper if real usage shows the manual predecessor/successor map
   assembly shown in the `StatePathPicker` example above is too much
   boilerplate per integrator.
10. Full multi-level `$ref` resolution in `unwrapJsonSchema` — walking into
    `$defs`/`definitions` for every nested (non-root) `$ref`, with a cycle
    guard for a genuinely recursive type, so a nested `$ref` property gets
    a typed editor instead of `SlotField`'s raw-JSON fallback — plus
    best-effort `allOf` property-union merging (see [Seam completeness
    (d)](#seam-completeness-four-open-questions)).

---

## Test strategy

Follows `packages/react`'s existing Vitest/RTL conventions
(`// @vitest-environment jsdom` docblock only on component tests,
pure-logic tests run in the default `node` environment). One departure,
stated plainly rather than claimed as conformance: `packages/react/test/`
is flat today (`test/auto-layout.test.ts` for `src/lib/auto-layout.ts`,
`test/PipelineNodeCard.test.tsx` for `src/canvas/PipelineNodeCard.tsx` — no
subdirectories). The test files below use `test/lib/…`, `test/validation/…`
paths that *introduce* a nested convention rather than follow an existing
one; the config's `include` glob (`packages/**/test/**/*.test.{ts,tsx}`)
already picks up nested directories either way, so nothing breaks, but this
is a new layout choice for the package, not a continuation of one:

```
packages/react/test/
  NodePalette.test.tsx            # jsdom — search/group/drag-payload/click-to-add,
                                   #   the providerCompat "N unsupported" pill
  InspectorPanel.test.tsx         # jsdom — render loop over unwrapJsonSchema(inputSchema)
                                   #   .properties, including a root-$ref/$defs-wrapped
                                   #   inputSchema rendering the same slots as an unwrapped
                                   #   one (the zero-slots-on-wrapped-schema regression); a
                                   #   nullable slot (anyOf/oneOf with one non-null variant)
                                   #   rendering its real type's editor, not the text-input
                                   #   fallback; kind switching, disabled-fieldset, error
                                   #   display
  StatePathPicker.test.tsx        # jsdom — root/leaf rendering, compat-gated disabling,
                                   #   the two distinct empty states, `current`-driven
                                   #   active-leaf highlighting
  ValidationDisplay.test.tsx      # jsdom — tone rendering, collapse/expand, 5-item cap
  lib/json-schema.test.ts         # node — unwrapJsonSchema: no-op on an unwrapped schema,
                                   #   resolves a v3 $ref+definitions root, resolves a v4
                                   #   $ref+$defs root, resolves the correct bag when both
                                   #   $defs and definitions are present on the same schema
                                   #   (prefix-match, not bag-presence), leaves a nested
                                   #   (non-root) $ref un-dereferenced (documented Phase 1
                                   #   limit); unwrapNullableUnion: collapses a
                                   #   single-non-null-variant anyOf/oneOf to that variant,
                                   #   no-op on a multi-variant union, no-op when there's no
                                   #   union at all
  lib/binding-defaults.test.ts    # node — every JSON-Schema type -> its correct default
                                   #   (an object-typed slot's literal default is `{}`,
                                   #   never `''`; a JSON-textarea commit for an array slot
                                   #   is `[]`-typed, never a string); a nullable schema
                                   #   (anyOf/oneOf, one non-null variant) defaults/coerces
                                   #   against its real type, not the union catch-all; the
                                   #   un-coercible branch (a string parsed for an object
                                   #   slot, NaN for a number slot) falls back to
                                   #   literalDefaultForType and never throws;
                                   #   defaultBindingForKind('state', schema) is `undefined`
                                   #   for every schema shape
  lib/state-path-tree.test.ts     # node — ancestor walk (through unwrapJsonSchema and
                                   #   unwrapNullableUnion), the built-in meta root (present
                                   #   by default, omitted when includeMetaRoot: false),
                                   #   oneOf/anyOf first-variant-only for a genuine
                                   #   multi-variant union, compat fallback; regression-pins
                                   #   the validateStatePath filter on BOTH root kinds (an
                                   #   ancestor outputSchema property named `constructor`,
                                   #   containing a `.`/space, or nested past MAX_PATH_DEPTH
                                   #   is dropped, never emitted as a leaf)
  validation/prune.test.ts        # node — both prune triggers (slot fixed, node removed),
                                   #   confirms a `tone: 'blocking'` issue is never pruned
                                   #   by this path (only re-validation clears it)
  validation/adapt-compile-error.test.ts  # node — maps a multi-entry
                                   #   PipelineCompileError.entries to
                                   #   ValidationIssueView[] with tone: 'blocking'
                                   #   on every entry; a TOPOLOGY_NO_ENTRY/
                                   #   IF_MISSING_BRANCH entry (kind values outside
                                   #   GraphValidationIssue['code']) round-trips
                                   #   through `code: string` without a type error
```

Coverage: extend `vitest.config.ts`'s per-package `thresholds` with new
entries for `packages/react/src/palette/**`, `packages/react/src/inspector/**`,
`packages/react/src/validation/**`, at floors set the same way the existing
ones are — a few points below measured coverage once these land, not an
aspiration set in advance. The three new `lib/*.ts` files (`json-schema.ts`,
`binding-defaults.ts`, `state-path-tree.ts`) need no new threshold entry:
they land under the **existing** `packages/react/src/lib/**` floor
(90/90/90, `vitest.config.ts:36` — already the strictest in the package),
which already applies to any new file under that path.

The coercion-bug regression tests in `binding-defaults.test.ts`, plus the
nullable-union collapse tests in both `json-schema.test.ts` and
`binding-defaults.test.ts`, are the highest-priority tests in this whole
surface. The entire point of extracting `defaultBindingForKind`/
`coerceLiteralToSchemaType`/`unwrapNullableUnion` as standalone,
directly-testable functions is to make a type-mismatched or
silently-downgraded binding mechanically impossible to reintroduce without
a failing test.

---

## `openpipeline-scheduler` migration notes

**Caveat up front**: `openpipeline-scheduler` is a separate, non-public
repo not readable from this worktree. Everything below is guidance inferred
from what's documented about it in *this* repo (`README.md:366-372`: "the
full-stack reference... wires these packages into a real multi-tenant,
authenticated product"; `CHANGELOG.md:470-481`: it historically carried a
local patch, `patches/@openpipeline__react@0.1.0.patch`, against
`@openpipeline/react`, and consumes `@openpipeline/mcp`'s dynamic-OAuth via
a local adapter) — it is **not verified against the scheduler's actual
code**, exactly the same caveat the prior `CHANGELOG.md` entry for
scheduler consumers already used ("this section documents guidance only").

1. **Catalog shape**: if the scheduler's catalog endpoint (analogous to the
   playground's `/catalog`) doesn't already emit full `inputSchema`/
   `outputSchema` JSON Schema per node — check whether it derives its
   existing hand-built inspector's form fields from something structurally
   equivalent already, since a real product's inspector almost certainly
   needed the shape info somewhere. If so, that's the thing to expose as
   `NodeSpecDescriptor.inputSchema`/`outputSchema` rather than
   re-deriving it.
2. **Replace the hand-built inspector** with `InspectorPanel` +
   `StatePathPicker`, supplying:
   - `getSlotVisibility` for any scheduler-specific per-node-type slot
     gating it has accumulated — same hook shape, own data, whatever the
     scheduler's own capability matrices turn out to be.
   - `stateRoots` from `buildStatePathTree` — note this only exposes the
     built-in `meta` root (`PipelineMeta`'s actual fields) plus
     upstream-node outputs (see [`StatePathPicker`](#3-statepathpicker)
     above; a consumer-supplied `opts.graphInputSchema` generalization was
     considered and dropped, not shipped). If the scheduler's own
     run-trigger metadata isn't already reachable through `PipelineMeta`'s
     `context.userId`/`context.tenantId`, it has no path into
     `StatePathPicker` today — that gap needs the engine-level run-input
     channel flagged as a follow-up in [Explicit
     non-goals](#explicit-non-goals), not something the scheduler can work
     around unilaterally.
3. **Replace the hand-built palette** with `NodePalette`, supplying a
   `groupBy` matching however the scheduler currently organizes its own
   node catalog UI (per-provider grouping is the most likely candidate —
   the same reasoning that motivated `groupBy` being a hook rather than a
   fixed kit default in the first place), and `providerCompat` if the
   scheduler already surfaces MCP-tool-compatibility counts anywhere.
4. **Retire the `@openpipeline__react` patch** once pinned to the 0.6.0
   release containing this work — per CHANGELOG 0.2.0, the patch was already
   removable at any `@openpipeline/react` > 0.1.0; verify the consumer's
   pnpm `patchedDependencies` entry is gone when bumping.
5. **Do this after Phase 2**, not incrementally against Phase 1 alone —
   `ValidationDisplay`/`NodePalette` alone don't remove the scheduler's
   hand-built inspector, which is almost certainly the larger of its two
   custom UI investments given a schema-driven inspector is typically the
   bigger build of the two.

This section should be revisited and corrected by whoever has access to
`openpipeline-scheduler`'s actual code before being treated as a checklist
— it is deliberately written as informed guidance, not a verified plan, the
same distinction `CHANGELOG.md` already draws for that repo.

---

## Explicit non-goals

- **No new package.** Everything above ships inside `@openpipeline/react`
  — no `@openpipeline/builder-kit` or similar.
- **Not solving `@openpipeline/core`'s own `@langchain/langgraph` hard
  dependency.** Flagged as [Phase 3 item
  7](#phased-implementation-plan), not attempted here.
- **Not a fluent, code-first pipeline DSL.** Already an explicit
  README-level non-goal (`README.md:390-392`) — this spec doesn't touch it
  either; the builder kit is a *visual* authoring surface, consistent with
  that decision.
- **Not hosted product features.** No auth, no multi-tenancy, no catalog
  fetching baked into any of these components — consumer-owned, matching
  every existing `@openpipeline/react` convention.
- **Not baking in any product-specific coupling.** No built-in HTTP client,
  session/auth handling, or platform-bridge code; no built-in
  icon-provider integration; no fixed brand color palette beyond
  `PipelineNodeCard`'s existing neutral one; no non-English default
  strings; no fixed section-grouping heuristic; no hardcoded per-node-type
  visibility switch; no hardcoded state-root leaves. Every one of these
  stays a consumer-supplied hook or prop, matching every existing
  `@openpipeline/react` convention.
- **Not implementing reachability analysis** for `SlotStatus`'s
  `auto_unreachable` state — a stated Phase 1 simplification (see [Phase 3
  item 8](#phased-implementation-plan)), not silently dropped or silently
  fixed.
- **Not adding a zod runtime dependency to `@openpipeline/react`.** All
  three components consume `SlotJsonSchema`, never a live zod object —
  keeps the package's current zero-zod-dependency fact (verified above)
  true after this work lands.
- **Not modifying `@openpipeline/nodes`' or `@openpipeline/core`'s public
  behavior**, except widening `computeAncestors`'s parameter type in
  `@openpipeline/core` (see [Phase 2 step 5](#phased-implementation-plan)
  — a structural widening of the accepted input, not a behavior change,
  non-breaking for every existing caller). `validateGraph`'s logic, output
  shape, `@openpipeline/nodes`' own exports, and the `CompilerDeps.validate`
  hook it composes with are all untouched.
- **Not implementing save-time graph validation.** `PipelineEngine.save()`
  persists an unvalidated draft today (`packages/runtime/src/index.ts:
  276-278`) and `POST /pipeline` returns `200` unconditionally
  (`packages/server/src/node-http.ts:75`) — `validateGraph` only runs
  inside `engine.run()`, and cannot run client-side at all (see
  "Current-state facts" above). Giving `save()` an opt-in `validate` step
  is a real engine/server behavior change, not a docs or
  `@openpipeline/react` change, and is out of scope for this spec — see
  [Phase 2 step 6](#phased-implementation-plan). Tracked as a follow-up
  decision, not silently assumed solved.
- **Not adding an engine-level, free-form run-input channel.** An earlier
  draft of `StatePathPicker`'s "Building `roots`" considered generalizing
  the built-in `meta` root into a consumer-supplied `opts.graphInputSchema`
  — dropped, because `RunOptions` (`packages/runtime/src/index.ts:108-123`)
  accepts no user-supplied graph-level input and `PipelineMeta`
  (`packages/core/src/state.ts:23-40`) is a closed shape, so no run-state
  channel exists for such a schema's leaves to resolve against; a path
  built from it would pass `validateStatePath` and then silently resolve
  to `undefined` at run time. `buildStatePathTree`'s only non-node-output
  root is therefore the built-in `meta` one, statically grounded in
  `PipelineMeta`'s actual fields. Extending `RunOptions`/`PipelineState`
  with a real, consumer-defined run-input channel is a separate, later
  engine decision — tracked here as a follow-up, not solved by this spec.
- **Not shipping a tool hover card for 0.6.0.** See [Seam completeness
  (b)](#seam-completeness-four-open-questions).
- **Not merging `allOf` schemas.** See [Seam completeness
  (d)](#seam-completeness-four-open-questions).

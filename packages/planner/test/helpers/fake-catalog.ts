import type {
  CatalogLoader,
  CatalogResult,
  McpNodeResolver,
  NodeSpec,
  ResolvedProvider,
} from '@openpipeline/core';

/** Default single-provider/single-tool catalog: `mcp:demo:lookup`. */
export const DEFAULT_FAKE_PROVIDERS: ResolvedProvider[] = [
  {
    key: 'demo',
    displayName: 'Demo',
    tools: [
      {
        name: 'lookup',
        description: 'A tool with no declared output schema.',
        invoke: () => Promise.resolve({}),
      },
    ],
  },
];

export interface FakeCatalogLoader extends CatalogLoader {
  /** How many times `load()` was actually called — asserts the "at most once per plan()" cache contract. */
  readonly loadCalls: number;
  /** How many times a `load()`-returned `cleanup()` was actually called — asserts the "exactly once" contract. */
  readonly cleanupCalls: number;
}

/**
 * A minimal, deterministic `CatalogLoader` fake. Tracks `load()`/`cleanup()`
 * call counts via getters backed by a private closure (not spread onto the
 * returned object, which would freeze a stale snapshot) so tests can assert
 * `select.node.ts`'s "load at most once per `plan()` call" caching and
 * `planner.ts`'s "`cleanup()` fires exactly once, on every exit path"
 * guarantee without reaching into private state.
 */
export function makeFakeCatalogLoader(
  providers: ResolvedProvider[] = DEFAULT_FAKE_PROVIDERS
): FakeCatalogLoader {
  const state = { loadCalls: 0, cleanupCalls: 0 };
  return {
    get loadCalls() {
      return state.loadCalls;
    },
    get cleanupCalls() {
      return state.cleanupCalls;
    },
    load(): Promise<CatalogResult> {
      state.loadCalls += 1;
      return Promise.resolve({
        providers,
        cleanup: (): Promise<void> => {
          state.cleanupCalls += 1;
          return Promise.resolve();
        },
      });
    },
  };
}

export interface FakeMcpNodeResolver extends McpNodeResolver {
  /** Every key `resolveSpec` was actually called with, in call order. */
  readonly resolveCalls: string[];
}

/**
 * A minimal `McpNodeResolver` fake resolving only the keys present in
 * `specsByKey`; any other key rejects (fail-soft per key is `select.node.ts`'s
 * job to catch, not this fake's).
 */
export function makeFakeMcpNodeResolver(
  specsByKey: ReadonlyMap<string, NodeSpec>
): FakeMcpNodeResolver {
  const resolveCalls: string[] = [];
  return {
    resolveCalls,
    resolveSpec(key: string): Promise<NodeSpec> {
      resolveCalls.push(key);
      const spec = specsByKey.get(key);
      if (!spec) return Promise.reject(new Error(`[fake] no spec registered for MCP key "${key}"`));
      return Promise.resolve(spec);
    },
  };
}

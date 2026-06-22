import {
  validateStatePath,
  NOOP_LOGGER,
  type ValueBinding,
  type NodeInputs,
  type PipelineStateType,
  type Logger,
} from '@openpipeline/core';

function getByPath(obj: unknown, path: string): unknown {
  // Normalize `[n]` -> `.n`, then split and drop empty tokens (handles the
  // `.[n]` variant some UIs emit when joining path segments).
  const keys = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Resolves `literal` and `state` bindings against the run state. `auto`
 * bindings are left for the AutoParamResolver. De-@Injectable'd; logger is
 * injected (defaults to no-op).
 */
export class ValueBindingResolver {
  constructor(private readonly logger: Logger = NOOP_LOGGER) {}

  resolveExplicit(
    inputs: NodeInputs,
    state: PipelineStateType,
    debugCtx?: { nodeId: string; nodeLabel: string }
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [paramName, binding] of Object.entries(inputs)) {
      if (binding.kind === 'auto') continue;
      result[paramName] = this.resolveOne(binding, state);
    }
    if (debugCtx) {
      const summary = Object.entries(inputs)
        .filter(([, b]) => b.kind !== 'auto')
        .map(([param, b]) => `${param}:${b.kind}`)
        .join(' ');
      this.logger.debug(
        `[ValueBindingResolver] ${debugCtx.nodeLabel} (id=${debugCtx.nodeId.slice(0, 8)}) ${summary || '(no explicit)'}`
      );
    }
    return result;
  }

  resolveOne(binding: ValueBinding, state: PipelineStateType): unknown {
    switch (binding.kind) {
      case 'literal':
        return binding.value;
      case 'state': {
        const check = validateStatePath(binding.path);
        if (!check.valid) {
          throw new Error(`[ValueBinding] invalid state.path "${binding.path}": ${check.error}`);
        }
        return getByPath(state, binding.path);
      }
      case 'auto':
        throw new Error('[ValueBinding] auto binding must be resolved by the AutoParamResolver');
    }
  }
}

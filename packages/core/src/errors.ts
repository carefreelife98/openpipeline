import type { PipelineError } from './state.js';

/** Thrown by the compiler when a graph fails validation or a compile invariant. */
export interface CompileErrorEntry {
  scope: 'graph' | 'node';
  kind: string;
  message: string;
  nodeId?: string;
  nodeKey?: string;
}

export class PipelineCompileError extends Error {
  override readonly name = 'PipelineCompileError';
  constructor(
    readonly entries: CompileErrorEntry[],
    readonly pipelineName: string
  ) {
    super(`Pipeline "${pipelineName}" failed to compile: ${entries.map((e) => e.kind).join(', ')}`);
  }
}

/** Thrown when a run is aborted via its AbortSignal. */
export class PipelineAbortedError extends Error {
  override readonly name = 'PipelineAbortedError';
  constructor() {
    super('Pipeline run aborted');
  }
}

/** Wraps a node-handler failure with the originating node id. */
export class PipelineNodeExecutionError extends Error {
  override readonly name = 'PipelineNodeExecutionError';
  constructor(
    readonly nodeId: string,
    readonly pipelineError: PipelineError
  ) {
    super(pipelineError.message);
  }
}

/** Thrown when a run cannot start because of a conflicting state (replaces NestJS ConflictException). */
export class PipelineConflictError extends Error {
  override readonly name = 'PipelineConflictError';
}

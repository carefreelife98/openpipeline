import { END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';

import { readPlannerState } from '../src/planner.js';
import { PlannerStateAnnotation } from '../src/state.js';

/**
 * T1 review round 3, M1: fix pass 2 removed the only node-level
 * `plannerWarnings` producer (`design.node.ts` no longer returns the key —
 * `PipelinePlanner.plan` seeds it once instead), which left the channel with
 * exactly one write per real run. A single write behaves identically under
 * APPEND and under last-write-wins, so D7's "APPEND, never last-write-wins"
 * decision (state.ts:81-84) had no regression guard left: flipping the
 * reducer to `(_existing, update) => update` still passed the full suite.
 *
 * Drives TWO separate writes through the actual compiled channel (not a
 * hand-called reducer function) so this fails the instant the reducer stops
 * being an accumulator.
 */
describe('PlannerStateAnnotation — plannerWarnings channel (D7)', () => {
  it('appends across multiple node writes rather than last-write-wins', async () => {
    const graph = new StateGraph(PlannerStateAnnotation)
      .addNode('first', (() => Promise.resolve({ plannerWarnings: ['warning-a'] })) as never)
      .addNode('second', (() => Promise.resolve({ plannerWarnings: ['warning-b'] })) as never)
      .addEdge(START, 'first')
      .addEdge('first', 'second')
      .addEdge('second', END)
      .compile();

    const result = readPlannerState(await graph.invoke({ instruction: 'x' }));

    // Last-write-wins would leave only ['warning-b']; APPEND (D7) must keep
    // both, in the order they were written.
    expect(result.plannerWarnings).toEqual(['warning-a', 'warning-b']);
  });
});

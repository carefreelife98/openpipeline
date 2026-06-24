/**
 * Pure helper extracted from DeletableEdge so the branch-label decision is unit
 * testable without a full React Flow render (edge components only render inside a
 * real <ReactFlow> graph, which jsdom can't measure).
 *
 * Returns the branch badge text for an IF edge (`'true'`/`'false'`), or `null`
 * for a plain edge.
 */
export function branchLabelOf(label: string | null | undefined): 'true' | 'false' | null {
  return label === 'true' || label === 'false' ? label : null;
}

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

import { branchLabelOf } from '../lib/edge-label.js';

/**
 * Edge with a hover delete affordance. The delete handler is supplied via edge
 * data (`onDelete`) so the canvas wires it to the store.
 */
export function DeletableEdge(props: EdgeProps): React.JSX.Element {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
  } = props;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const data = props.data as { label?: string | null; onDelete?: (id: string) => void } | undefined;
  const branchLabel = branchLabelOf(data?.label);
  const onDelete = data?.onDelete;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
            pointerEvents: 'all',
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
          className="nodrag nopan"
        >
          {branchLabel && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 5px',
                borderRadius: 6,
                color: '#fff',
                background: branchLabel === 'true' ? '#10b981' : '#ef4444',
              }}
            >
              {branchLabel}
            </span>
          )}
          {onDelete && (
            <button
              onClick={() => {
                onDelete(id);
              }}
              title="Delete"
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                border: 'none',
                background: '#ef4444',
                color: '#fff',
                fontSize: 10,
                lineHeight: '16px',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BuilderNode, NodeRunStatus } from '../types.js';

const STATUS_COLOR: Record<NodeRunStatus, string> = {
  WAITING: '#94a3b8',
  RUNNING: '#6366f1',
  SUCCESS: '#10b981',
  FAILED: '#ef4444',
  ABORTED: '#f59e0b',
};

export interface WorkflowNodeData {
  node: BuilderNode;
  /** Live run status, fed in by the consumer via node data. */
  runStatus?: NodeRunStatus;
  selected?: boolean;
  [key: string]: unknown;
}

/**
 * Default node renderer. Inline-styled so the library imposes no CSS framework.
 * Consumers can supply their own node component via `nodeTypes` if they want a
 * different look.
 */
export function WorkflowNodeCard(props: NodeProps): JSX.Element {
  const data = props.data as WorkflowNodeData;
  const node = data.node;
  const isIf = node.nodeType === 'IF';
  const statusColor = data.runStatus ? STATUS_COLOR[data.runStatus] : undefined;

  return (
    <div
      style={{
        minWidth: 180,
        borderRadius: 10,
        border: `1.5px solid ${props.selected ? '#6366f1' : (statusColor ?? '#e2e8f0')}`,
        background: '#ffffff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />

      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {node.nodeType}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{node.label}</div>
      </div>
      <div style={{ padding: '6px 12px', fontSize: 12, color: '#475569' }}>
        <code style={{ fontSize: 11, color: '#7c3aed' }}>{node.key}</code>
        {statusColor && (
          <span style={{ float: 'right', color: statusColor, fontWeight: 600 }}>{data.runStatus}</span>
        )}
      </div>

      {isIf ? (
        <>
          <Handle
            id="branch-true"
            type="source"
            position={Position.Right}
            style={{ top: '35%', background: '#10b981' }}
          />
          <Handle
            id="branch-false"
            type="source"
            position={Position.Right}
            style={{ top: '65%', background: '#ef4444' }}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
      )}
    </div>
  );
}

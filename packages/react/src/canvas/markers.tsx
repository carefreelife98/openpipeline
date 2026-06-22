import { Handle, Position, type NodeProps } from '@xyflow/react';

function markerStyle(color: string): React.CSSProperties {
  return {
    width: 56,
    height: 56,
    borderRadius: '50%',
    border: `2px solid ${color}`,
    background: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 12,
    fontWeight: 700,
    color,
  };
}

export function StartMarker(props: NodeProps): React.JSX.Element {
  const label = (props.data as { label?: string }).label ?? 'Start';
  return (
    <div style={markerStyle('#10b981')}>
      {label}
      <Handle type="source" position={Position.Right} style={{ background: '#10b981' }} />
    </div>
  );
}

export function EndMarker(props: NodeProps): React.JSX.Element {
  const label = (props.data as { label?: string }).label ?? 'End';
  return (
    <div style={markerStyle('#94a3b8')}>
      {label}
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
    </div>
  );
}

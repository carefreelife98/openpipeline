// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, it, expect } from 'vitest';

import { PipelineNodeCard, type PipelineNodeData } from '../src/canvas/PipelineNodeCard.js';
import type { BuilderNode } from '../src/types.js';

// React Flow node components read context (Handle), so render inside a provider.
function renderCard(data: PipelineNodeData, selected = false) {
  // NodeProps has many required fields; the card only reads `data` + `selected`.
  const props = { data, selected } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <PipelineNodeCard {...props} />
    </ReactFlowProvider>
  );
}

function toolNode(overrides: Partial<BuilderNode> = {}): BuilderNode {
  return {
    id: 'n1',
    nodeType: 'TOOL',
    key: 'tool.uppercase',
    label: 'Uppercase',
    inputs: {},
    ...overrides,
  };
}

describe('PipelineNodeCard', () => {
  it('renders the node label, type, and key', () => {
    renderCard({ node: toolNode() });
    expect(screen.getByText('Uppercase')).toBeInTheDocument();
    expect(screen.getByText('TOOL')).toBeInTheDocument();
    expect(screen.getByText('tool.uppercase')).toBeInTheDocument();
  });

  it('shows the run status label when a runStatus is provided', () => {
    renderCard({ node: toolNode(), runStatus: 'RUNNING' });
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });

  it('does not show a status label when runStatus is absent', () => {
    renderCard({ node: toolNode() });
    for (const status of ['WAITING', 'RUNNING', 'SUCCESS', 'FAILED', 'ABORTED']) {
      expect(screen.queryByText(status)).not.toBeInTheDocument();
    }
  });

  it('renders an IF node (two source handles) without crashing and shows its key', () => {
    renderCard({ node: toolNode({ nodeType: 'IF', key: 'control.if', label: 'Gate' }) });
    expect(screen.getByText('Gate')).toBeInTheDocument();
    expect(screen.getByText('IF')).toBeInTheDocument();
    expect(screen.getByText('control.if')).toBeInTheDocument();
  });
});

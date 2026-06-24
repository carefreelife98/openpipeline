// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, it, expect } from 'vitest';

import { StartMarker, EndMarker } from '../src/canvas/markers.js';

function renderNode(el: React.JSX.Element) {
  return render(<ReactFlowProvider>{el}</ReactFlowProvider>);
}
function nodeProps(data: unknown): NodeProps {
  return { data } as unknown as NodeProps;
}

describe('StartMarker / EndMarker', () => {
  it('StartMarker shows the default "Start" label', () => {
    renderNode(<StartMarker {...nodeProps({})} />);
    expect(screen.getByText('Start')).toBeInTheDocument();
  });

  it('EndMarker shows the default "End" label', () => {
    renderNode(<EndMarker {...nodeProps({})} />);
    expect(screen.getByText('End')).toBeInTheDocument();
  });

  it('uses a custom label from node data when provided', () => {
    renderNode(<StartMarker {...nodeProps({ label: 'Begin here' })} />);
    expect(screen.getByText('Begin here')).toBeInTheDocument();
    expect(screen.queryByText('Start')).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeAll } from 'vitest';

import { BuilderCanvas } from '../src/canvas/BuilderCanvas.js';
import { createBuilderStore } from '../src/store/builder-store.js';

// React Flow needs ResizeObserver (absent in jsdom) to measure the canvas.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeStore() {
  const store = createBuilderStore();
  store.getState().loadDraft({
    name: 'demo',
    nodes: [
      { id: 'upper', nodeType: 'TOOL', key: 'tool.uppercase', label: 'Uppercase', inputs: {} },
      { id: 'gate', nodeType: 'IF', key: 'control.if', label: 'Gate', inputs: {} },
    ],
    edges: [{ id: 'e1', fromNodeId: 'upper', toNodeId: 'gate' }],
  });
  return store;
}

describe('BuilderCanvas', () => {
  it('renders the controlled store nodes (node cards show their labels)', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 600, height: 400 }}>
          <BuilderCanvas store={makeStore()} />
        </div>
      </ReactFlowProvider>
    );
    // Node cards render their label even before React Flow measures positions.
    expect(screen.getByText('Uppercase')).toBeInTheDocument();
    expect(screen.getByText('Gate')).toBeInTheDocument();
  });

  it('renders read-only (editable=false) without crashing', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 600, height: 400 }}>
          <BuilderCanvas store={makeStore()} editable={false} />
        </div>
      </ReactFlowProvider>
    );
    expect(screen.getByText('Uppercase')).toBeInTheDocument();
  });

  it('applies a live nodeRunStatus overlay to a node card', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 600, height: 400 }}>
          <BuilderCanvas store={makeStore()} nodeRunStatus={{ upper: 'RUNNING' }} />
        </div>
      </ReactFlowProvider>
    );
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });
});

import type { PipelineDraft } from '@openpipeline/core';
import { BuilderCanvas, createBuilderStore } from '@openpipeline/react';
import type { NodeRunStatus, NodeSpecDescriptor } from '@openpipeline/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import '@xyflow/react/dist/style.css';

/**
 * The playground IS the reference auth/router wrapper a consumer copies. It owns:
 *   - data loading: GET the seed pipeline -> store.loadDraft(...)
 *   - persistence: store.toDraft() -> POST /pipeline
 *   - running: GET the SSE stream -> nodeRunStatus overlay
 *   - the palette: add nodes from the catalog
 * @openpipeline/react contributes only the canvas + store.
 */
export function App(): React.JSX.Element {
  const store = useMemo(() => createBuilderStore(), []);
  const [catalog, setCatalog] = useState<NodeSpecDescriptor[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [nodeRunStatus, setNodeRunStatus] = useState<Record<string, NodeRunStatus>>({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const dirty = store((s) => s.dirty);
  const seeded = useRef(false);

  // Load the catalog + seed pipeline once.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void (async () => {
      const cat = (await (await fetch('/catalog')).json()) as NodeSpecDescriptor[];
      setCatalog(cat);
      const { pipelineId: id } = (await (await fetch('/seed')).json()) as { pipelineId: string };
      const graph = (await (await fetch(`/pipeline/${id}`)).json()) as {
        pipeline: { id: string; name: string; description?: string };
        nodes: PipelineDraft['nodes'];
        edges: PipelineDraft['edges'];
      };
      store.getState().loadDraft({
        id: graph.pipeline.id,
        name: graph.pipeline.name,
        description: graph.pipeline.description,
        nodes: graph.nodes,
        edges: graph.edges,
      });
      setPipelineId(id);
    })();
  }, [store]);

  async function save() {
    const draft = store.getState().toDraft();
    const res = await fetch('/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const { pipelineId: id } = (await res.json()) as { pipelineId: string };
    setPipelineId(id);
    store.getState().markClean();
    pushLog(`saved (${id.slice(0, 8)})`);
  }

  async function run() {
    if (!pipelineId) return;
    if (dirty) await save();
    setRunning(true);
    setNodeRunStatus({});
    pushLog('run started');
    const res = await fetch(`/pipeline/runs/x/stream?pipelineId=${pipelineId}`);
    if (!res.body) throw new Error('SSE response has no body stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(5)) as {
          kind: string;
          nodeId?: string;
          status?: string;
        };
        const nodeId = event.nodeId;
        if (event.kind === 'NODE_START' && nodeId) {
          setNodeRunStatus((s) => ({ ...s, [nodeId]: 'RUNNING' }));
        } else if (event.kind === 'NODE_END' && nodeId) {
          setNodeRunStatus((s) => ({ ...s, [nodeId]: 'SUCCESS' }));
        } else if (event.kind === 'NODE_FAILED' && nodeId) {
          setNodeRunStatus((s) => ({ ...s, [nodeId]: 'FAILED' }));
        } else if (event.kind === 'RUN_COMPLETE') {
          pushLog(`run complete: ${event.status ?? 'unknown'}`);
        }
      }
    }
    setRunning(false);
  }

  function pushLog(msg: string) {
    setLog((l) => [...l.slice(-6), msg]);
  }

  function addNode(spec: NodeSpecDescriptor) {
    const id = crypto.randomUUID();
    store.getState().addNode({
      id,
      nodeType: spec.nodeType,
      key: spec.key,
      label: spec.displayName,
      inputs: {},
      positionX: 300 + Math.random() * 120,
      positionY: 150 + Math.random() * 120,
    });
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', height: '100%' }}>
      {/* Palette + controls */}
      <aside
        style={{
          borderRight: '1px solid #e2e8f0',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>OpenPipeline</strong>
        <span style={{ fontSize: 11, color: '#64748b' }}>Playground</span>
        <hr style={{ width: '100%', border: 'none', borderTop: '1px solid #e2e8f0' }} />
        <span style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase' }}>Nodes</span>
        {catalog.map((spec) => (
          <button
            key={spec.key}
            onClick={() => {
              addNode(spec);
            }}
            style={{
              textAlign: 'left',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid #e2e8f0',
              background: '#fff',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            + {spec.displayName}
          </button>
        ))}
        <hr style={{ width: '100%', border: 'none', borderTop: '1px solid #e2e8f0' }} />
        <button
          onClick={() => {
            void save();
          }}
          style={btn('#6366f1')}
        >
          Save{dirty ? ' *' : ''}
        </button>
        <button
          onClick={() => {
            void run();
          }}
          disabled={running}
          style={btn(running ? '#94a3b8' : '#10b981')}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        <div style={{ marginTop: 'auto', fontSize: 11, color: '#64748b' }}>
          {log.map((l, i) => (
            <div key={i}>· {l}</div>
          ))}
        </div>
      </aside>

      {/* Canvas */}
      <main style={{ height: '100%' }}>
        <ReactFlowProvider>
          <BuilderCanvas store={store} nodeRunStatus={nodeRunStatus} />
        </ReactFlowProvider>
      </main>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    padding: '8px 10px',
    borderRadius: 6,
    border: 'none',
    background: color,
    color: '#fff',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  };
}

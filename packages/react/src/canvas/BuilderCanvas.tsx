import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes,
  type Node as RfNode,
} from '@xyflow/react';
import type { BuilderStore } from '../store/builder-store.js';
import type { NodeRunStatus, BuilderStrings } from '../types.js';
import { DEFAULT_STRINGS } from '../types.js';
import { buildDisplayNodes, buildDisplayEdges, stripMarkers } from '../lib/serializer.js';
import {
  isMarkerEdge,
  isStartMarkerEdge,
  sourceLabelFromHandle,
  START_MARKER_ID,
  END_MARKER_ID,
} from '../lib/markers.js';
import { PipelineNodeCard, type PipelineNodeData } from './PipelineNodeCard.js';
import { DeletableEdge } from './DeletableEdge.js';
import { StartMarker, EndMarker } from './markers.js';

const DEFAULT_NODE_TYPES: NodeTypes = {
  pipelineNode: PipelineNodeCard,
  startMarker: StartMarker,
  endMarker: EndMarker,
};

const DEFAULT_EDGE_TYPES: EdgeTypes = {
  deletable: DeletableEdge,
};

const genEdgeId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `e_${Math.random().toString(36).slice(2)}`;

export interface BuilderCanvasProps {
  /** The builder store created by `createBuilderStore()`. */
  store: BuilderStore;
  /** Live per-node run status overlay (e.g. fed from engine.onEvent). */
  nodeRunStatus?: Record<string, NodeRunStatus>;
  /** Override node renderers. Merged over the defaults. */
  nodeTypes?: NodeTypes;
  /** Override edge renderers. Merged over the defaults. */
  edgeTypes?: EdgeTypes;
  /** User-facing strings (English defaults). */
  strings?: Partial<BuilderStrings>;
  /** Whether the canvas is editable (false = read-only preview). Default true. */
  editable?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The visual DAG builder canvas — a controlled component over a builder store.
 * Renders nodes/edges + START/END markers, wires drag/connect/delete back to the
 * store. No Next.js, no auth, no ApiClient: the consumer owns data loading
 * (`store.loadDraft`) and persistence (`store.toDraft` -> their save endpoint).
 *
 * Wrap usage in `<ReactFlowProvider>` and import `@xyflow/react/dist/style.css`.
 */
export function BuilderCanvas(props: BuilderCanvasProps): React.JSX.Element {
  const useStore = props.store;
  const strings = { ...DEFAULT_STRINGS, ...props.strings };
  const editable = props.editable ?? true;

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const startTargets = useStore((s) => s.startTargets);
  const endSources = useStore((s) => s.endSources);
  const startMarker = useStore((s) => s.startMarker);
  const endMarker = useStore((s) => s.endMarker);

  const updateNodePosition = useStore((s) => s.updateNodePosition);
  const updateMarkerPosition = useStore((s) => s.updateMarkerPosition);
  const removeNode = useStore((s) => s.removeNode);
  const removeEdge = useStore((s) => s.removeEdge);
  const addEdge = useStore((s) => s.addEdge);
  const addStartTarget = useStore((s) => s.addStartTarget);
  const removeStartTarget = useStore((s) => s.removeStartTarget);
  const addEndSource = useStore((s) => s.addEndSource);
  const removeEndSource = useStore((s) => s.removeEndSource);
  const selectNode = useStore((s) => s.selectNode);

  const displayNodes = useMemo(() => {
    const built = buildDisplayNodes(nodes, startMarker, endMarker, {
      start: strings.startLabel,
      end: strings.endLabel,
    });
    if (!props.nodeRunStatus) return built;
    return built.map((n) =>
      n.type === 'pipelineNode'
        ? { ...n, data: { ...(n.data as PipelineNodeData), runStatus: props.nodeRunStatus![n.id] } }
        : n
    );
  }, [nodes, startMarker, endMarker, strings.startLabel, strings.endLabel, props.nodeRunStatus]);

  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      if (isMarkerEdge(edgeId)) {
        const { startTargets: st, endSources: es } = stripMarkers([
          { id: edgeId, source: '', target: '' } as never,
        ]);
        void st;
        void es;
        // Marker edges encode their node id; remove from the right list.
        const nodeId = edgeId.replace(/^__edge_(start|end)__/, '');
        if (isStartMarkerEdge(edgeId)) removeStartTarget(nodeId);
        else removeEndSource(nodeId);
      } else {
        removeEdge(edgeId);
      }
    },
    [removeEdge, removeStartTarget, removeEndSource]
  );

  const displayEdges = useMemo(() => {
    const built = buildDisplayEdges(edges, startTargets, endSources);
    return built.map((e) => ({
      ...e,
      data: { ...e.data, onDelete: editable ? handleDeleteEdge : undefined },
    }));
  }, [edges, startTargets, endSources, editable, handleDeleteEdge]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          if (change.id === START_MARKER_ID)
            updateMarkerPosition('start', change.position.x, change.position.y);
          else if (change.id === END_MARKER_ID)
            updateMarkerPosition('end', change.position.x, change.position.y);
          else updateNodePosition(change.id, change.position.x, change.position.y);
        } else if (change.type === 'remove') {
          if (change.id !== START_MARKER_ID && change.id !== END_MARKER_ID) removeNode(change.id);
        } else if (change.type === 'select') {
          selectNode(change.selected ? change.id : null);
        }
      }
    },
    [updateNodePosition, updateMarkerPosition, removeNode, selectNode]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') handleDeleteEdge(change.id);
      }
    },
    [handleDeleteEdge]
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      // START / END marker connections become start targets / end sources.
      if (conn.source === START_MARKER_ID) {
        addStartTarget(conn.target);
        return;
      }
      if (conn.target === END_MARKER_ID) {
        addEndSource(conn.source);
        return;
      }
      addEdge({
        id: genEdgeId(),
        fromNodeId: conn.source,
        toNodeId: conn.target,
        label: sourceLabelFromHandle(conn.sourceHandle) ?? null,
      });
    },
    [addEdge, addStartTarget, addEndSource]
  );

  const nodeTypes = useMemo(
    () => ({ ...DEFAULT_NODE_TYPES, ...props.nodeTypes }),
    [props.nodeTypes]
  );
  const edgeTypes = useMemo(
    () => ({ ...DEFAULT_EDGE_TYPES, ...props.edgeTypes }),
    [props.edgeTypes]
  );

  const isEmpty = nodes.length === 0;

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', ...props.style }}
      className={props.className}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={editable ? handleNodesChange : undefined}
        onEdgesChange={editable ? handleEdgesChange : undefined}
        onConnect={editable ? handleConnect : undefined}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable={editable}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="#e2e8f0" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n: RfNode) => (n.type === 'pipelineNode' ? '#6366f1' : '#94a3b8')}
        />
      </ReactFlow>

      {isEmpty && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            fontFamily: 'system-ui, sans-serif',
            color: '#94a3b8',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: '#64748b' }}>
            {strings.emptyTitle}
          </div>
          <div style={{ fontSize: 13, marginTop: 6, maxWidth: 360 }}>{strings.emptyHint}</div>
        </div>
      )}
    </div>
  );
}

import type { CostBundle, PipelineDraft, RunDeliveryMode, StepFinish } from '@openpipeline/core';
import { ZERO_COST } from '@openpipeline/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { PrismaPipelineStore } from '../src/index.js';
import type { PrismaClientLike } from '../src/prisma-types.js';

// ── Inspectable in-memory fake satisfying PrismaClientLike ──────────────────
//
// Reuses the structural fake-client pattern from examples/prisma/index.ts but
// keeps the backing tables reachable so assertions can inspect persisted rows
// (the example only logs final output; tests need to read intermediate state).
// The delegate semantics the store depends on are emulated faithfully:
//   - `where` matching incl. the `{ in: [...] }` operator
//   - findUnique `include` with soft-delete filtering on nodes
//   - findFirst `orderBy.sequenceIndex: desc`
//   - the atomic cost jsonb UPDATE via $executeRawUnsafe (5 deltas + runId)

type TableName = 'pipeline' | 'pipelineNode' | 'pipelineEdge' | 'pipelineRun' | 'pipelineRunStep';
type Row = Record<string, unknown>;

interface Cost {
  tokens: { input: number; output: number; total: number };
  dollars: number;
  llmCalls: number;
}

const FAKE_ZERO_COST: Cost = { tokens: { input: 0, output: 0, total: 0 }, dollars: 0, llmCalls: 0 };

function asCost(value: unknown): Cost {
  if (value && typeof value === 'object' && 'tokens' in value) {
    return value as Cost;
  }
  return FAKE_ZERO_COST;
}

interface FakePrisma {
  client: PrismaClientLike;
  tables: Record<TableName, Map<string, Row>>;
  rowsOf: (name: TableName) => Row[];
  /** Count of $executeRawUnsafe invocations — proves the raw atomic path ran. */
  rawExecCount: () => number;
  lastRawQuery: () => string | undefined;
}

function createFakePrisma(): FakePrisma {
  const tables: Record<TableName, Map<string, Row>> = {
    pipeline: new Map(),
    pipelineNode: new Map(),
    pipelineEdge: new Map(),
    pipelineRun: new Map(),
    pipelineRunStep: new Map(),
  };
  let seq = 0;
  let rawCalls = 0;
  let lastQuery: string | undefined;
  const id = (p: string): string => `${p}_${(seq++).toString(36)}`;

  const matches = (row: Row, where: unknown): boolean => {
    if (!where || typeof where !== 'object') return true;
    for (const [k, v] of Object.entries(where as Row)) {
      if (v && typeof v === 'object' && 'in' in v) {
        if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };

  const rowId = (candidate: unknown, table: TableName): string =>
    typeof candidate === 'string' ? candidate : id(table);

  const delegate = (name: TableName): PrismaClientLike[TableName] => {
    const t = tables[name];
    return {
      create: <TRow extends { id: string }>({ data }: { data: object }): Promise<TRow> => {
        const d = data as Row;
        const rid = rowId(d.id, name);
        const row: Row = {
          ...d,
          id: rid,
          startedAt: new Date(),
          sequenceIndex: d.sequenceIndex ?? 0,
        };
        t.set(rid, row);
        return Promise.resolve(row as unknown as TRow);
      },
      createMany: ({
        data,
      }: {
        data: object[];
        skipDuplicates?: boolean;
      }): Promise<{ count: number }> => {
        for (const d0 of data) {
          const d = d0 as Row;
          const rid = rowId(d.id, name);
          t.set(rid, { ...d, id: rid });
        }
        return Promise.resolve({ count: data.length });
      },
      findUnique: <TRow>({
        where,
        include,
      }: {
        where: unknown;
        include?: unknown;
        select?: unknown;
      }): Promise<TRow | null> => {
        const row = t.get((where as { id: string }).id);
        if (!row) return Promise.resolve(null);
        const out: Row = { ...row };
        const inc = include as Row | undefined;
        if (inc?.nodes) {
          out.nodes = [...tables.pipelineNode.values()].filter(
            (n) => n.pipelineId === row.id && !n.isDeleted
          );
        }
        if (inc?.edges) {
          out.edges = [...tables.pipelineEdge.values()].filter((e) => e.pipelineId === row.id);
        }
        return Promise.resolve(out as unknown as TRow);
      },
      findFirst: <TRow>({
        where,
        orderBy,
      }: {
        where?: unknown;
        orderBy?: unknown;
        select?: unknown;
        include?: unknown;
        take?: number;
      }): Promise<TRow | null> => {
        let rows = [...t.values()].filter((r) => matches(r, where));
        if ((orderBy as { sequenceIndex?: string } | undefined)?.sequenceIndex === 'desc') {
          rows = rows.sort((a, b) => (b.sequenceIndex as number) - (a.sequenceIndex as number));
        }
        return Promise.resolve((rows[0] ?? null) as TRow | null);
      },
      findMany: <TRow>(args?: {
        where?: unknown;
        orderBy?: unknown;
        select?: unknown;
        include?: unknown;
        take?: number;
      }): Promise<TRow[]> => {
        let rows = [...t.values()].filter((r) => matches(r, args?.where));
        const ob = args?.orderBy as { startedAt?: string } | undefined;
        if (ob?.startedAt === 'desc') {
          rows = rows.sort(
            (a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime()
          );
        }
        if (args?.take) rows = rows.slice(0, args.take);
        return Promise.resolve(rows as unknown as TRow[]);
      },
      update: <TRow extends { id: string }>({
        where,
        data,
      }: {
        where: unknown;
        data: object;
      }): Promise<TRow> => {
        const rid = (where as { id: string }).id;
        const row = { ...t.get(rid), ...data, id: rid } as Row;
        t.set(rid, row);
        return Promise.resolve(row as unknown as TRow);
      },
      updateMany: ({
        where,
        data,
      }: {
        where: unknown;
        data: object;
      }): Promise<{ count: number }> => {
        let n = 0;
        for (const [rid, row] of t) {
          if (matches(row, where)) {
            t.set(rid, { ...row, ...data });
            n++;
          }
        }
        return Promise.resolve({ count: n });
      },
      deleteMany: ({ where }: { where: unknown }): Promise<{ count: number }> => {
        let n = 0;
        for (const [rid, row] of t) {
          if (matches(row, where)) {
            t.delete(rid);
            n++;
          }
        }
        return Promise.resolve({ count: n });
      },
    };
  };

  const client: PrismaClientLike = {
    pipeline: delegate('pipeline'),
    pipelineNode: delegate('pipelineNode'),
    pipelineEdge: delegate('pipelineEdge'),
    pipelineRun: delegate('pipelineRun'),
    pipelineRunStep: delegate('pipelineRunStep'),
    $transaction: <T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T> => fn(client),
    $executeRawUnsafe: (query: string, ...values: unknown[]): Promise<number> => {
      rawCalls++;
      lastQuery = query;
      const [i, o, tot, dollars, calls, runId] = values;
      const run = tables.pipelineRun.get(String(runId));
      if (run) {
        const prev = asCost(run.cost);
        run.cost = {
          tokens: {
            input: prev.tokens.input + Number(i),
            output: prev.tokens.output + Number(o),
            total: prev.tokens.total + Number(tot),
          },
          dollars: prev.dollars + Number(dollars),
          llmCalls: prev.llmCalls + Number(calls),
        };
      }
      return Promise.resolve(1);
    },
  };

  return {
    client,
    tables,
    rowsOf: (name) => [...tables[name].values()],
    rawExecCount: () => rawCalls,
    lastRawQuery: () => lastQuery,
  };
}

const STREAM: RunDeliveryMode = 'STREAM';

function draft(overrides: Partial<PipelineDraft> = {}): PipelineDraft {
  return {
    name: 'wf',
    nodes: [
      {
        id: 'n1',
        nodeType: 'TOOL',
        key: 'tool.double',
        label: 'Double',
        inputs: { n: { kind: 'literal', value: 21 } },
      },
      {
        id: 'n2',
        nodeType: 'TOOL',
        key: 'tool.double',
        label: 'Again',
        inputs: { n: { kind: 'state', path: 'outputs.n1.result' } },
      },
    ],
    edges: [{ id: 'e1', fromNodeId: 'n1', toNodeId: 'n2' }],
    ...overrides,
  };
}

describe('PrismaPipelineStore.save — create path', () => {
  it('creates a pipeline row and returns its id', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const id = await store.save(draft({ name: 'created' }));

    const pipelines = fake.rowsOf('pipeline');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.id).toBe(id);
    expect(pipelines[0]?.name).toBe('created');
  });

  it('persists nodes and edges supplied in the draft', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const id = await store.save(draft());

    const nodes = fake.rowsOf('pipelineNode');
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.pipelineId === id)).toBe(true);
    expect(fake.rowsOf('pipelineEdge')).toHaveLength(1);
  });

  it('normalizes absent description / schema / positions to null', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await store.save(draft());

    expect(fake.rowsOf('pipeline')[0]?.description).toBeNull();
    expect(fake.rowsOf('pipeline')[0]?.outputJsonSchema).toBeNull();
    const node = fake.rowsOf('pipelineNode')[0];
    expect(node?.positionX).toBeNull();
    expect(node?.positionY).toBeNull();
  });

  it('preserves an edge label when given, null otherwise', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await store.save(
      draft({
        edges: [
          { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', label: 'true' },
          { id: 'e2', fromNodeId: 'n1', toNodeId: 'n2' },
        ],
      })
    );

    const edges = fake.rowsOf('pipelineEdge');
    const labels = edges.map((e) => e.label).sort();
    expect(labels).toEqual([null, 'true']);
  });

  it('creates a pipeline with no nodes/edges without error', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const id = await store.save({ name: 'empty', nodes: [], edges: [] });

    expect(fake.rowsOf('pipeline')).toHaveLength(1);
    expect(fake.rowsOf('pipelineNode')).toHaveLength(0);
    expect(fake.rowsOf('pipelineEdge')).toHaveLength(0);
    expect(typeof id).toBe('string');
  });
});

describe('PrismaPipelineStore.save — diff update path', () => {
  it('returns the same id and updates scalar fields', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ name: 'before' }));

    const same = await store.save(draft({ id, name: 'after', description: 'desc' }));

    expect(same).toBe(id);
    expect(fake.rowsOf('pipeline')[0]?.name).toBe('after');
    expect(fake.rowsOf('pipeline')[0]?.description).toBe('desc');
  });

  it('soft-deletes nodes that are absent from the new draft', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    // Drop n2, keep only n1.
    await store.save(
      draft({
        id,
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Double',
            inputs: { n: { kind: 'literal', value: 21 } },
          },
        ],
        edges: [],
      })
    );

    const byId = new Map(fake.rowsOf('pipelineNode').map((n) => [n.id, n]));
    expect(byId.get('n1')?.isDeleted).toBe(false);
    expect(byId.get('n2')?.isDeleted).toBe(true);
    expect(byId.get('n2')?.deletedAt).toBeInstanceOf(Date);
  });

  it('restores a previously soft-deleted node when it reappears in a draft', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());
    // Remove n2 (soft-delete).
    await store.save(
      draft({
        id,
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Double',
            inputs: { n: { kind: 'literal', value: 21 } },
          },
        ],
        edges: [],
      })
    );
    // Bring n2 back.
    await store.save(draft({ id }));

    const n2 = fake.rowsOf('pipelineNode').find((n) => n.id === 'n2');
    expect(n2?.isDeleted).toBe(false);
    expect(n2?.deletedAt).toBeNull();
  });

  it('updates an existing node in place rather than duplicating it', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    await store.save(
      draft({
        id,
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'RENAMED',
            inputs: { n: { kind: 'literal', value: 99 } },
          },
          {
            id: 'n2',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Again',
            inputs: { n: { kind: 'state', path: 'outputs.n1.result' } },
          },
        ],
      })
    );

    const n1Rows = fake.rowsOf('pipelineNode').filter((n) => n.id === 'n1');
    expect(n1Rows).toHaveLength(1);
    expect(n1Rows[0]?.label).toBe('RENAMED');
  });

  it('creates a brand-new node added during an update', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    await store.save(
      draft({
        id,
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Double',
            inputs: { n: { kind: 'literal', value: 21 } },
          },
          {
            id: 'n2',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Again',
            inputs: { n: { kind: 'state', path: 'outputs.n1.result' } },
          },
          {
            id: 'n3',
            nodeType: 'IF',
            key: 'control.if',
            label: 'Gate',
            inputs: { condition: { kind: 'literal', value: true } },
          },
        ],
      })
    );

    const n3 = fake.rowsOf('pipelineNode').find((n) => n.id === 'n3');
    expect(n3).toBeDefined();
    expect(n3?.pipelineId).toBe(id);
    expect(n3?.isDeleted).toBe(false);
  });

  it('recreates edges from scratch on each update (delete-then-create)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());
    expect(fake.rowsOf('pipelineEdge')).toHaveLength(1);

    // Update with two edges; old edge(s) cleared first, so exactly two remain.
    await store.save(
      draft({
        id,
        edges: [
          { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', label: 'a' },
          { id: 'e2', fromNodeId: 'n2', toNodeId: 'n1', label: 'b' },
        ],
      })
    );

    expect(fake.rowsOf('pipelineEdge')).toHaveLength(2);
  });

  it('clears all edges when the new draft has none', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    await store.save(draft({ id, edges: [] }));

    expect(fake.rowsOf('pipelineEdge')).toHaveLength(0);
  });
});

describe('PrismaPipelineStore.load', () => {
  it('round-trips a saved pipeline into a PipelineWithGraph', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ name: 'loadable', description: 'd' }));

    const loaded = await store.load(id);

    expect(loaded.pipeline.id).toBe(id);
    expect(loaded.pipeline.name).toBe('loadable');
    expect(loaded.pipeline.description).toBe('d');
    expect(loaded.nodes).toHaveLength(2);
    expect(loaded.edges).toHaveLength(1);
  });

  it('maps a null description to undefined (domain shape)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    const loaded = await store.load(id);

    expect(loaded.pipeline.description).toBeUndefined();
  });

  it('excludes soft-deleted nodes from the loaded graph', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());
    await store.save(
      draft({
        id,
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Double',
            inputs: { n: { kind: 'literal', value: 21 } },
          },
        ],
        edges: [],
      })
    );

    const loaded = await store.load(id);

    expect(loaded.nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('defaults a node with null inputs to an empty object', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save({
      name: 'wf',
      nodes: [
        {
          id: 'solo',
          nodeType: 'TOOL',
          key: 'tool.noop',
          label: 'Noop',
          inputs: {},
        },
      ],
      edges: [],
    });
    // Simulate a legacy row that stored null inputs.
    const node = fake.tables.pipelineNode.get('solo');
    if (node) node.inputs = null;

    const loaded = await store.load(id);

    expect(loaded.nodes[0]?.inputs).toEqual({});
  });

  it('throws a descriptive error when the pipeline does not exist', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await expect(store.load('missing-id')).rejects.toThrow(/Pipeline not found: missing-id/);
  });
});

describe('PrismaPipelineStore.createRun / completeRun', () => {
  it('creates a RUNNING run seeded with zero cost', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const { runId, startedAt } = await store.createRun({
      pipelineId: 'p1',
      deliveryMode: STREAM,
    });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('RUNNING');
    expect(row?.cost).toEqual(ZERO_COST);
    expect(startedAt).toBeInstanceOf(Date);
  });

  it('defaults triggerSource to MANUAL and userId/input to null/empty', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.triggerSource).toBe('MANUAL');
    expect(row?.userId).toBeNull();
    expect(row?.input).toEqual({});
  });

  it('persists provided userId, triggerSource and input', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const { runId } = await store.createRun({
      pipelineId: 'p1',
      deliveryMode: STREAM,
      userId: 'audit-user',
      triggerSource: 'WEBHOOK',
      input: { a: 1 },
    });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.userId).toBe('audit-user');
    expect(row?.triggerSource).toBe('WEBHOOK');
    expect(row?.input).toEqual({ a: 1 });
  });

  it('writes output and finishedAt on SUCCESS completion', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.completeRun(runId, { status: 'SUCCESS', output: { ok: true } });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('SUCCESS');
    expect(row?.output).toEqual({ ok: true });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('does not write output on SUCCESS when output is undefined', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.completeRun(runId, { status: 'SUCCESS' });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('SUCCESS');
    expect('output' in (row ?? {})).toBe(false);
  });

  it('writes error and lastState on FAILED but not output', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.completeRun(runId, {
      status: 'FAILED',
      error: { code: 'NODE_EXECUTION_ERROR', message: 'boom' },
      lastState: { step: 'n1' },
      output: { ignored: true },
    });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toEqual({ code: 'NODE_EXECUTION_ERROR', message: 'boom' });
    expect(row?.lastState).toEqual({ step: 'n1' });
    expect('output' in (row ?? {})).toBe(false);
  });

  it('treats ABORTED as a failure (records error/lastState branch)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.completeRun(runId, { status: 'ABORTED', error: undefined });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('ABORTED');
    // error key written (null) because the isFailure branch ran.
    expect('error' in (row ?? {})).toBe(true);
    expect(row?.error).toBeNull();
  });

  it('persists a final cost bundle when one is supplied', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });
    const cost: CostBundle = {
      tokens: { input: 5, output: 7, total: 12 },
      dollars: 0.5,
      llmCalls: 2,
    };

    await store.completeRun(runId, { status: 'SUCCESS', cost });

    expect(fake.tables.pipelineRun.get(runId)?.cost).toEqual(cost);
  });
});

describe('PrismaPipelineStore.updateRunCostAtomic', () => {
  const delta = (over: Partial<CostBundle> = {}): CostBundle => ({
    tokens: { input: 1, output: 2, total: 3 },
    dollars: 0.01,
    llmCalls: 1,
    ...over,
  });

  it('routes through the raw SQL path (parameterized UPDATE)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.updateRunCostAtomic(runId, delta());

    expect(fake.rawExecCount()).toBe(1);
    expect(fake.lastRawQuery()).toMatch(/UPDATE pipeline_run/);
    expect(fake.lastRawQuery()).toMatch(/jsonb_build_object/);
  });

  it('adds the delta to a zero-cost run', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.updateRunCostAtomic(runId, delta());

    expect(fake.tables.pipelineRun.get(runId)?.cost).toEqual({
      tokens: { input: 1, output: 2, total: 3 },
      dollars: 0.01,
      llmCalls: 1,
    });
  });

  it('accumulates across multiple calls (race-free read-modify-write)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    await store.updateRunCostAtomic(runId, delta());
    await store.updateRunCostAtomic(
      runId,
      delta({ tokens: { input: 10, output: 20, total: 30 }, dollars: 0.99, llmCalls: 4 })
    );

    expect(fake.tables.pipelineRun.get(runId)?.cost).toEqual({
      tokens: { input: 11, output: 22, total: 33 },
      dollars: 1.0,
      llmCalls: 5,
    });
  });

  it('passes deltas as positional params in the documented order', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    // Distinct values per field prove ordering: input!=output!=total etc.
    await store.updateRunCostAtomic(runId, {
      tokens: { input: 100, output: 200, total: 300 },
      dollars: 4.5,
      llmCalls: 6,
    });

    expect(fake.tables.pipelineRun.get(runId)?.cost).toEqual({
      tokens: { input: 100, output: 200, total: 300 },
      dollars: 4.5,
      llmCalls: 6,
    });
  });
});

describe('PrismaPipelineStore.listRuns', () => {
  it('returns runs for a pipeline ordered most-recent-first', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const first = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });
    // Force a strictly later startedAt on the second run.
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    const runs = await store.listRuns('p1');

    expect(runs.map((r) => r.id)).toEqual([second.runId, first.runId]);
  });

  it('scopes results to the requested pipeline', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });
    await store.createRun({ pipelineId: 'p2', deliveryMode: STREAM });

    const runs = await store.listRuns('p1');

    expect(runs).toHaveLength(1);
    expect(runs[0]?.pipelineId).toBe('p1');
  });

  it('honours the limit option', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    for (let i = 0; i < 3; i++) {
      await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });
      await new Promise((r) => setTimeout(r, 1));
    }

    const runs = await store.listRuns('p1', { limit: 2 });

    expect(runs).toHaveLength(2);
  });

  it('projects each row into a RunSummary with finishedAt undefined while running', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    const [run] = await store.listRuns('p1');

    expect(run?.status).toBe('RUNNING');
    expect(run?.finishedAt).toBeUndefined();
    expect(run?.cost).toEqual(ZERO_COST);
  });

  it('falls back to a zero cost bundle for a legacy null-cost row', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });
    const row = fake.tables.pipelineRun.get(runId);
    if (row) row.cost = null;

    const [run] = await store.listRuns('p1');

    expect(run?.cost).toEqual(ZERO_COST);
  });

  it('returns an empty array for a pipeline with no runs', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    expect(await store.listRuns('nope')).toEqual([]);
  });
});

describe('PrismaPipelineStore step sequencing (StepRecorder)', () => {
  it('assigns sequenceIndex 0 to the first step of a run', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });

    const row = fake.tables.pipelineRunStep.get(stepId);
    expect(row?.sequenceIndex).toBe(0);
    expect(row?.status).toBe('RUNNING');
    expect(row?.cost).toEqual(ZERO_COST);
  });

  it('increments sequenceIndex monotonically across sequential starts', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const a = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const b = await store.start({ runId: 'r1', nodeId: 'n2', nodeLabel: 'B' });
    const c = await store.start({ runId: 'r1', nodeId: 'n3', nodeLabel: 'C' });

    expect(fake.tables.pipelineRunStep.get(a)?.sequenceIndex).toBe(0);
    expect(fake.tables.pipelineRunStep.get(b)?.sequenceIndex).toBe(1);
    expect(fake.tables.pipelineRunStep.get(c)?.sequenceIndex).toBe(2);
  });

  it('keeps sequence counters independent per run', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const r2first = await store.start({ runId: 'r2', nodeId: 'n1', nodeLabel: 'A' });

    expect(fake.tables.pipelineRunStep.get(r2first)?.sequenceIndex).toBe(0);
  });

  it('serializes concurrent fan-in starts into unique consecutive indices', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    // Fire many start() calls concurrently for the same run; the per-run mutex
    // must serialize them so no two share a sequenceIndex.
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.start({ runId: 'r1', nodeId: `n${String(i)}`, nodeLabel: `L${String(i)}` })
      )
    );

    const indices = ids
      .map((id) => fake.tables.pipelineRunStep.get(id)?.sequenceIndex)
      .sort((a, b) => Number(a) - Number(b));
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('records the supplied nodeLabel and a null parentStepId for top-level steps', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'Pretty Label' });

    const row = fake.tables.pipelineRunStep.get(stepId);
    expect(row?.nodeLabel).toBe('Pretty Label');
    expect(row?.parentStepId).toBeNull();
  });
});

describe('PrismaPipelineStore.startChild / finishChild', () => {
  it('records a child step under its parent with its own sequenceIndex', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const parent = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'Parent' });

    const child = await store.startChild({
      runId: 'r1',
      parentStepId: parent,
      nodeId: 'sub',
      input: { x: 1 },
    });

    const row = fake.tables.pipelineRunStep.get(child);
    expect(row?.parentStepId).toBe(parent);
    expect(row?.sequenceIndex).toBe(1);
    // nodeId doubles as the label for synthesized child steps.
    expect(row?.nodeLabel).toBe('sub');
  });

  it('finishChild updates the child step status and output', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const parent = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'Parent' });
    const child = await store.startChild({
      runId: 'r1',
      parentStepId: parent,
      nodeId: 'sub',
      input: {},
    });

    await store.finishChild(child, { status: 'SUCCESS', output: { done: true } });

    const row = fake.tables.pipelineRunStep.get(child);
    expect(row?.status).toBe('SUCCESS');
    expect(row?.output).toEqual({ done: true });
  });
});

describe('PrismaPipelineStore.finish', () => {
  it('writes status, output, cost and finishedAt on success', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const cost: CostBundle = {
      tokens: { input: 3, output: 4, total: 7 },
      dollars: 0.2,
      llmCalls: 1,
    };

    await store.finish(stepId, { status: 'SUCCESS', output: { r: 42 }, cost, input: { n: 1 } });

    const row = fake.tables.pipelineRunStep.get(stepId);
    expect(row?.status).toBe('SUCCESS');
    expect(row?.output).toEqual({ r: 42 });
    expect(row?.input).toEqual({ n: 1 });
    expect(row?.cost).toEqual(cost);
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('defaults cost to zero and output/error to null when omitted', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });

    await store.finish(stepId, { status: 'FAILED' });

    const row = fake.tables.pipelineRunStep.get(stepId);
    expect(row?.status).toBe('FAILED');
    expect(row?.cost).toEqual(ZERO_COST);
    expect(row?.output).toBeNull();
    expect(row?.error).toBeNull();
  });

  it('records an error payload on a failed step', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const result: StepFinish = {
      status: 'FAILED',
      error: { code: 'NODE_EXECUTION_ERROR', message: 'kaboom' },
    };

    await store.finish(stepId, result);

    expect(fake.tables.pipelineRunStep.get(stepId)?.error).toEqual({
      code: 'NODE_EXECUTION_ERROR',
      message: 'kaboom',
    });
  });
});

describe('PrismaPipelineStore.finalizeStaleSteps', () => {
  it('marks only still-RUNNING steps of the run as FAILED', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const running = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const finished = await store.start({ runId: 'r1', nodeId: 'n2', nodeLabel: 'B' });
    await store.finish(finished, { status: 'SUCCESS' });

    await store.finalizeStaleSteps('r1');

    expect(fake.tables.pipelineRunStep.get(running)?.status).toBe('FAILED');
    expect(fake.tables.pipelineRunStep.get(running)?.finishedAt).toBeInstanceOf(Date);
    // Already-finished step is untouched.
    expect(fake.tables.pipelineRunStep.get(finished)?.status).toBe('SUCCESS');
  });

  it('does not touch RUNNING steps belonging to other runs', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });
    const other = await store.start({ runId: 'r2', nodeId: 'n1', nodeLabel: 'A' });

    await store.finalizeStaleSteps('r1');

    expect(fake.tables.pipelineRunStep.get(other)?.status).toBe('RUNNING');
  });
});

describe('PrismaClientLike delegate-name alignment', () => {
  // The store calls prisma.<delegate>.<method>; a model rename in schema.prisma
  // would change the generated delegate name and crash at runtime. Exercising
  // every delegate through the public API proves the names the store reaches for
  // match the schema's camelCased model names.
  let touched: Set<string>;

  beforeEach(() => {
    touched = new Set();
  });

  it('reaches pipeline, pipelineNode, pipelineEdge, pipelineRun and pipelineRunStep', async () => {
    const fake = createFakePrisma();
    // Wrap each delegate's create to record which delegate names were used.
    const names: TableName[] = [
      'pipeline',
      'pipelineNode',
      'pipelineEdge',
      'pipelineRun',
      'pipelineRunStep',
    ];
    for (const name of names) {
      const original = fake.client[name].create.bind(fake.client[name]);
      fake.client[name].create = <TRow extends { id: string }>(args: {
        data: object;
      }): Promise<TRow> => {
        touched.add(name);
        return original<TRow>(args);
      };
      const originalMany = fake.client[name].createMany.bind(fake.client[name]);
      fake.client[name].createMany = (args: {
        data: object[];
        skipDuplicates?: boolean;
      }): Promise<{ count: number }> => {
        touched.add(name);
        return originalMany(args);
      };
    }
    const store = new PrismaPipelineStore(fake.client);

    const id = await store.save(draft()); // pipeline + pipelineNode + pipelineEdge
    const { runId } = await store.createRun({ pipelineId: id, deliveryMode: STREAM }); // pipelineRun
    await store.start({ runId, nodeId: 'n1', nodeLabel: 'A' }); // pipelineRunStep

    expect([...touched].sort()).toEqual([...names].sort());
  });
});

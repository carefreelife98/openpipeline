import type { CostBundle, PipelineDraft, RunDeliveryMode, StepFinish } from '@openpipeline/core';
import { PipelineNotFoundError, ZERO_COST } from '@openpipeline/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  // `pipelineNode.id` is a real global primary key in schema.prisma — not
  // scoped per pipeline. A create/createMany that supplies an id already
  // present in the table (belonging to ANY pipeline, including a different
  // one) collides on that PK. Real Prisma surfaces this as a P2002 unique-
  // constraint violation; simulate that here so a test against this fake can
  // tell the difference between "the store pre-empted the clash with a clear
  // ownership error" and "the store let it fall through to a confusing P2002"
  // (S4/#10) — matching real Postgres behavior instead of silently
  // overwriting the row via `Map.set`.
  const rejectIfNodeIdTaken = (rid: string): void => {
    if (tables.pipelineNode.has(rid)) {
      throw new Error(
        `Unique constraint failed on the fields: (\`id\`) [P2002] — pipelineNode id "${rid}" already exists`
      );
    }
  };

  const delegate = (name: TableName): PrismaClientLike[TableName] => {
    const t = tables[name];
    return {
      create: <TRow extends { id: string }>({ data }: { data: object }): Promise<TRow> => {
        const d = data as Row;
        const rid = rowId(d.id, name);
        if (name === 'pipelineNode') rejectIfNodeIdTaken(rid);
        const row: Row = {
          ...d,
          id: rid,
          startedAt: new Date(),
          sequenceIndex: d.sequenceIndex ?? 0,
        };
        // Simulate schema.prisma's `@default(now())` / `@updatedAt` on the
        // `pipeline` model (#12) — a real Prisma client auto-populates both
        // on create unless the caller supplies its own value.
        if (name === 'pipeline') {
          row.createdAt ??= new Date();
          row.updatedAt ??= new Date();
        }
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
          if (name === 'pipelineNode') rejectIfNodeIdTaken(rid);
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
        // Simulate `@updatedAt` on the `pipeline` model (#12): auto-bump
        // UNLESS the caller explicitly supplied `updatedAt` (real Prisma
        // behavior — an explicit value always wins over the auto-timestamp).
        if (name === 'pipeline' && !('updatedAt' in (data as Row))) {
          row.updatedAt = new Date();
        }
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

describe('PrismaPipelineStore.save — userId attribution', () => {
  it('persists userId on create, null when omitted', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await store.save(draft({ userId: 'user-1' }));
    // Distinct node/edge ids — `pipelineNode.id` is a global PK, so reusing
    // n1/n2 from the first save would (correctly) trip the ownership guard.
    await store.save(draft({ name: 'anonymous', nodes: [], edges: [] }));

    const byName = new Map(fake.rowsOf('pipeline').map((p) => [p.name, p.userId]));
    expect(byName.get('wf')).toBe('user-1');
    expect(byName.get('anonymous')).toBeNull();
  });

  it('surfaces userId on load, mapping null to undefined', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    const owned = await store.save(draft({ userId: 'user-1' }));
    const anon = await store.save(draft({ name: 'anonymous', nodes: [], edges: [] }));

    expect((await store.load(owned)).pipeline.userId).toBe('user-1');
    expect((await store.load(anon)).pipeline.userId).toBeUndefined();
  });

  it('is sticky: an update that omits userId keeps the persisted value', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ userId: 'user-1' }));

    await store.save(draft({ id, name: 'renamed' }));

    expect(fake.rowsOf('pipeline')[0]?.name).toBe('renamed');
    expect(fake.rowsOf('pipeline')[0]?.userId).toBe('user-1');
  });

  it('overwrites userId when an update supplies one explicitly', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ userId: 'user-1' }));

    await store.save(draft({ id, userId: 'user-2' }));

    expect(fake.rowsOf('pipeline')[0]?.userId).toBe('user-2');
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

describe('PrismaPipelineStore.save — monotonic updatedAt on update (#12/S3)', () => {
  it('strictly bumps updatedAt forward across two updates landing in the same wall-clock millisecond', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ name: 'v1' }));
    const afterCreate = fake.tables.pipeline.get(id)?.updatedAt as Date;

    // Pin Date.now() so both updates land in the SAME millisecond — the
    // exact scenario a naive `@updatedAt` auto-timestamp collides on.
    const frozen = afterCreate.getTime();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    try {
      await store.save(draft({ id, name: 'v2' }));
      const afterFirstUpdate = fake.tables.pipeline.get(id)?.updatedAt as Date;
      await store.save(draft({ id, name: 'v3' }));
      const afterSecondUpdate = fake.tables.pipeline.get(id)?.updatedAt as Date;

      expect(afterFirstUpdate.getTime()).toBeGreaterThan(afterCreate.getTime());
      expect(afterSecondUpdate.getTime()).toBeGreaterThan(afterFirstUpdate.getTime());
    } finally {
      spy.mockRestore();
    }
  });

  it('produces a distinct compiler cache key across two same-millisecond updates', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft({ name: 'v1' }));
    const first = await store.load(id);

    const spy = vi.spyOn(Date, 'now').mockReturnValue(first.pipeline.updatedAt.getTime());
    try {
      await store.save(draft({ id, name: 'v2' }));
      const second = await store.load(id);

      const keyOf = (updatedAt: Date): string => `${id}:${String(updatedAt.getTime())}`;
      expect(keyOf(second.pipeline.updatedAt)).not.toBe(keyOf(first.pipeline.updatedAt));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PrismaPipelineStore.save — cross-pipeline node id ownership guard (S4/#10)', () => {
  it('rejects a client-supplied node id belonging to ANOTHER pipeline on create, with a clear ownership error', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    // Seed a node that already belongs to a different pipeline.
    fake.tables.pipelineNode.set('shared-id', {
      id: 'shared-id',
      pipelineId: 'someone-elses-pipeline',
      nodeType: 'TOOL',
      key: 'tool.x',
      label: 'X',
      inputs: {},
      isDeleted: false,
    });

    await expect(
      store.save({
        name: 'new-pipeline',
        nodes: [{ id: 'shared-id', nodeType: 'TOOL', key: 'tool.x', label: 'X', inputs: {} }],
        edges: [],
      })
    ).rejects.toThrow(/belongs? to another pipeline/i);
    // Never the raw, undiagnostic Prisma P2002 message.
    await expect(
      store.save({
        name: 'new-pipeline-2',
        nodes: [{ id: 'shared-id', nodeType: 'TOOL', key: 'tool.x', label: 'X', inputs: {} }],
        edges: [],
      })
    ).rejects.not.toThrow(/P2002/);
  });

  it('rejects a client-supplied node id belonging to ANOTHER pipeline on update', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft()); // pipeline with n1, n2
    fake.tables.pipelineNode.set('foreign-node', {
      id: 'foreign-node',
      pipelineId: 'someone-elses-pipeline',
      nodeType: 'TOOL',
      key: 'tool.x',
      label: 'X',
      inputs: {},
      isDeleted: false,
    });

    await expect(
      store.save({
        id,
        name: 'updated',
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.double',
            label: 'Double',
            inputs: { n: { kind: 'literal', value: 21 } },
          },
          { id: 'foreign-node', nodeType: 'TOOL', key: 'tool.x', label: 'X', inputs: {} },
        ],
        edges: [],
      })
    ).rejects.toThrow(/belongs? to another pipeline/i);
  });

  it('allows re-saving a draft whose node ids already belong to THIS SAME pipeline (own ids are not foreign)', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const id = await store.save(draft());

    // Re-save with the same node ids — must not be misclassified as foreign.
    await expect(store.save(draft({ id, name: 'renamed' }))).resolves.toBe(id);
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

  it('throws a typed PipelineNotFoundError when the pipeline does not exist', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await expect(store.load('missing-id')).rejects.toThrow(/Pipeline not found: missing-id/);
  });

  it('the thrown error is instanceof PipelineNotFoundError and carries the pipelineId', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    let caught: unknown;
    try {
      await store.load('missing-id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineNotFoundError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as PipelineNotFoundError).pipelineId).toBe('missing-id');
    expect((caught as PipelineNotFoundError).name).toBe('PipelineNotFoundError');
  });
});

describe('PrismaPipelineStore.load — infra failure characterization (must NOT become PipelineNotFoundError)', () => {
  // The whole point of a typed PipelineNotFoundError is that a consumer can
  // safely classify ONLY that error as 404 — a DB outage or any other
  // infrastructure failure reaching this same call site must propagate
  // unchanged, never get reclassified as "pipeline does not exist".
  it('propagates a connection failure from the underlying client unchanged', async () => {
    const fake = createFakePrisma();
    const infraError = new Error('ECONNREFUSED: connection refused');
    fake.client.pipeline.findUnique = () => Promise.reject(infraError);
    const store = new PrismaPipelineStore(fake.client);

    let caught: unknown;
    try {
      await store.load('any-id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(infraError);
    expect(caught).not.toBeInstanceOf(PipelineNotFoundError);
    expect((caught as Error).message).toBe('ECONNREFUSED: connection refused');
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
      error: { kind: 'NODE_EXECUTION', code: 'NODE_EXECUTION_ERROR', message: 'boom' },
      lastState: { step: 'n1' },
      output: { ignored: true },
    });

    const row = fake.tables.pipelineRun.get(runId);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toEqual({
      kind: 'NODE_EXECUTION',
      code: 'NODE_EXECUTION_ERROR',
      message: 'boom',
    });
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

describe('PrismaPipelineStore.completeRun first-terminal-wins', () => {
  it('returns true on first terminal transition, false and no-op on second', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);
    const { runId } = await store.createRun({ pipelineId: 'p1', deliveryMode: STREAM });

    const first = await store.completeRun(runId, { status: 'SUCCESS', output: { a: 1 } });
    const second = await store.completeRun(runId, { status: 'FAILED' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // FAILED로 역전되지 않음 — the guarded updateMany's where.status filter
    // rejects the second write once the run is already terminal.
    expect(fake.tables.pipelineRun.get(runId)?.status).toBe('SUCCESS');
  });

  it('is a no-op (returns false) for an unknown runId', async () => {
    const fake = createFakePrisma();
    const store = new PrismaPipelineStore(fake.client);

    await expect(store.completeRun('ghost', { status: 'FAILED' })).resolves.toBe(false);
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

describe('PrismaPipelineStore.serializeByRun — unhandled rejection guard (critical)', () => {
  // The per-run queue promise stashed in `startQueues` must never surface as
  // an unhandled rejection, even when the LAST start()/startChild() call for
  // a run rejects and the caller DOES catch the promise `start()` itself
  // returns — the map-stored derived promise is a separate object that
  // nothing else ever attaches a handler to. Without the fix this reliably
  // fires Node's `unhandledRejection` (and, outside a test harness that
  // intercepts it, `--unhandled-rejections=throw` kills the process).
  it('does not leave an unhandled rejection when the underlying create() rejects, even though the caller awaits/catches its own promise', async () => {
    const fake = createFakePrisma();
    fake.client.pipelineRunStep.create = () => Promise.reject(new Error('db exploded'));
    const store = new PrismaPipelineStore(fake.client);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' })).rejects.toThrow(
        'db exploded'
      );
      // Let Node's unhandled-rejection detector (which runs after the
      // microtask queue drains, on a later turn of the event loop) get a
      // chance to fire before asserting nothing was reported.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toEqual([]);
  });

  it('still serializes subsequent start() calls correctly after a prior call in the same run rejected', async () => {
    const fake = createFakePrisma();
    let failNext = true;
    const originalCreate = fake.client.pipelineRunStep.create.bind(fake.client.pipelineRunStep);
    fake.client.pipelineRunStep.create = <TRow extends { id: string }>(args: {
      data: object;
    }): Promise<TRow> => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('first call fails'));
      }
      return originalCreate<TRow>(args);
    };
    const store = new PrismaPipelineStore(fake.client);

    await expect(store.start({ runId: 'r1', nodeId: 'n0', nodeLabel: 'Zero' })).rejects.toThrow(
      'first call fails'
    );
    const stepId = await store.start({ runId: 'r1', nodeId: 'n1', nodeLabel: 'A' });

    const row = fake.tables.pipelineRunStep.get(stepId);
    expect(row?.sequenceIndex).toBe(0);
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
      error: { kind: 'NODE_EXECUTION', code: 'NODE_EXECUTION_ERROR', message: 'kaboom' },
    };

    await store.finish(stepId, result);

    expect(fake.tables.pipelineRunStep.get(stepId)?.error).toEqual({
      kind: 'NODE_EXECUTION',
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

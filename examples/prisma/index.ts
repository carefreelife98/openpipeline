/**
 * @openpipeline/store-prisma smoke run — drives the engine through
 * PrismaPipelineStore. A real deployment uses a PrismaClient generated from the
 * package's prisma/schema.prisma against Postgres:
 *
 *   import { PrismaClient } from '@openpipeline/store-prisma/src/generated';
 *   const store = new PrismaPipelineStore(new PrismaClient());
 *
 * To keep this example hermetic (no Postgres), we back the store with a tiny
 * in-memory object that satisfies the structural PrismaClientLike interface.
 * The store's logic (diff save, sequenced steps, atomic cost SQL path) is
 * exercised exactly as it would be against a real client.
 */
import { defineNode } from '@openpipeline/core';
import { createIfNodeSpec } from '@openpipeline/nodes';
import { PipelineEngine } from '@openpipeline/runtime';
import { PrismaPipelineStore, type PrismaClientLike } from '@openpipeline/store-prisma';
import { z } from 'zod';

// ── Minimal in-memory fake satisfying PrismaClientLike ──────────────────────
type TableName = 'pipeline' | 'pipelineNode' | 'pipelineEdge' | 'pipelineRun' | 'pipelineRunStep';
type Row = Record<string, unknown>;

interface Cost {
  tokens: { input: number; output: number; total: number };
  dollars: number;
  llmCalls: number;
}

const ZERO_COST: Cost = { tokens: { input: 0, output: 0, total: 0 }, dollars: 0, llmCalls: 0 };

/** Narrow a stored `cost` (typed `unknown` on the row) into a `Cost`, defaulting
 *  to zero when the run has not accrued any cost yet. */
function asCost(value: unknown): Cost {
  if (value && typeof value === 'object' && 'tokens' in value) {
    return value as Cost;
  }
  return ZERO_COST;
}

function createFakePrisma(): PrismaClientLike {
  const tables: Record<TableName, Map<string, Row>> = {
    pipeline: new Map(),
    pipelineNode: new Map(),
    pipelineEdge: new Map(),
    pipelineRun: new Map(),
    pipelineRunStep: new Map(),
  };
  let seq = 0;
  const id = (p: string) => `${p}_${(seq++).toString(36)}`;

  const matches = (row: Row, where: unknown): boolean => {
    if (!where || typeof where !== 'object') return true;
    for (const [k, v] of Object.entries(where as Row)) {
      if (v && typeof v === 'object' && 'in' in v) {
        if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };

  // Coerce an unknown candidate id into a string, generating one if absent.
  const rowId = (candidate: unknown, table: TableName) =>
    typeof candidate === 'string' ? candidate : id(table);

  // The delegate methods stay `Promise`-returning (the PrismaModelDelegate
  // contract is async), but the in-memory bodies have nothing to await, so they
  // return `Promise.resolve(...)` from a sync function rather than being `async`.
  const delegate = (name: TableName) => {
    const t = tables[name];
    return {
      create: ({ data }: { data: unknown }) => {
        const d = data as Row;
        const rid = rowId(d.id, name);
        const row: Row = {
          ...d,
          id: rid,
          startedAt: new Date(),
          sequenceIndex: d.sequenceIndex ?? 0,
        };
        t.set(rid, row);
        return Promise.resolve(row as { id: string });
      },
      createMany: ({ data }: { data: unknown[] }) => {
        for (const d0 of data) {
          const d = d0 as Row;
          const rid = rowId(d.id, name);
          t.set(rid, { ...d, id: rid });
        }
        return Promise.resolve({ count: data.length });
      },
      findUnique: ({ where, include }: { where: unknown; include?: unknown }) => {
        const row = t.get((where as { id: string }).id);
        if (!row) return Promise.resolve(null);
        const out: Row = { ...row };
        if (include && (include as Row).nodes) {
          out.nodes = [...tables.pipelineNode.values()].filter(
            (n) => n.pipelineId === row.id && !n.isDeleted
          );
        }
        if (include && (include as Row).edges) {
          out.edges = [...tables.pipelineEdge.values()].filter((e) => e.pipelineId === row.id);
        }
        return Promise.resolve(out);
      },
      findFirst: ({ where, orderBy }: { where?: unknown; orderBy?: unknown }) => {
        let rows = [...t.values()].filter((r) => matches(r, where));
        if (orderBy && (orderBy as { sequenceIndex?: string }).sequenceIndex === 'desc') {
          rows = rows.sort((a, b) => (b.sequenceIndex as number) - (a.sequenceIndex as number));
        }
        return Promise.resolve(rows[0] ?? null);
      },
      findMany: ({ where, take }: { where?: unknown; take?: number } = {}) => {
        let rows = [...t.values()].filter((r) => matches(r, where));
        if (take) rows = rows.slice(0, take);
        return Promise.resolve(rows);
      },
      update: ({ where, data }: { where: unknown; data: unknown }) => {
        const rid = (where as { id: string }).id;
        const row = { ...t.get(rid), ...(data as object), id: rid } as Row;
        t.set(rid, row);
        return Promise.resolve(row as { id: string });
      },
      updateMany: ({ where, data }: { where: unknown; data: unknown }) => {
        let n = 0;
        for (const [rid, row] of t) {
          if (matches(row, where)) {
            t.set(rid, { ...row, ...(data as object) });
            n++;
          }
        }
        return Promise.resolve({ count: n });
      },
      deleteMany: ({ where }: { where: unknown }) => {
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
    $transaction: async (fn) => fn(client),
    $executeRawUnsafe: (_query, ...values) => {
      // Emulate the atomic cost UPDATE: the store passes five numeric deltas
      // followed by the runId. Coerce each positional param explicitly rather
      // than trusting the `unknown[]` shape.
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
  return client;
}

// ── Run a pipeline through the Prisma store ─────────────────────────────────
const store = new PrismaPipelineStore(createFakePrisma());
const engine = new PipelineEngine({
  store,
  llmFactory: { createModel: () => ({ invoke: () => Promise.resolve({ content: '' }) }) },
  logger: console,
});

engine.registerNode(createIfNodeSpec());
engine.registerNode(
  defineNode({
    key: 'tool.double',
    nodeType: 'TOOL',
    displayName: 'Double',
    description: 'Doubles a number.',
    icon: 'calculator',
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({
      kind: z.literal('tool.double'),
      result: z.number(),
      positive: z.boolean(),
    }),
    handler: ({ n }) =>
      Promise.resolve({ kind: 'tool.double' as const, result: n * 2, positive: n * 2 > 0 }),
  })
);

const pipelineId = await store.save({
  name: 'double-then-branch',
  nodes: [
    {
      id: 'dbl',
      nodeType: 'TOOL',
      key: 'tool.double',
      label: 'Double',
      inputs: { n: { kind: 'literal', value: 21 } },
    },
    {
      id: 'gate',
      nodeType: 'IF',
      key: 'control.if',
      label: 'Positive?',
      inputs: { condition: { kind: 'state', path: 'outputs.dbl.positive' } },
    },
    {
      id: 'yes',
      nodeType: 'TOOL',
      key: 'tool.double',
      label: 'Again',
      inputs: { n: { kind: 'state', path: 'outputs.dbl.result' } },
    },
    {
      id: 'no',
      nodeType: 'TOOL',
      key: 'tool.double',
      label: 'Zero',
      inputs: { n: { kind: 'literal', value: 0 } },
    },
  ],
  edges: [
    { id: 'e1', fromNodeId: 'dbl', toNodeId: 'gate' },
    { id: 'e2', fromNodeId: 'gate', toNodeId: 'yes', label: 'true' },
    { id: 'e3', fromNodeId: 'gate', toNodeId: 'no', label: 'false' },
  ],
});

const { runId, done } = await engine.run({ pipelineId, context: { userId: 'demo-user' } });
const result = await done;
const runs = await store.listRuns(pipelineId);

console.log('\n── Result (Prisma store) ───────────────');
console.log('runId:', runId);
console.log('status:', result.status);
console.log('outputs:', JSON.stringify(result.outputs));
console.log('persisted run summary:', JSON.stringify(runs[0]));

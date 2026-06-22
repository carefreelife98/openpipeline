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
import { PipelineEngine } from '@openpipeline/runtime';
import { createIfNodeSpec } from '@openpipeline/nodes';
import { PrismaPipelineStore, type PrismaClientLike } from '@openpipeline/store-prisma';
import { defineNode } from '@openpipeline/core';
import { z } from 'zod';

// ── Minimal in-memory fake satisfying PrismaClientLike ──────────────────────
function createFakePrisma(): PrismaClientLike {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {
    pipeline: new Map(),
    pipelineNode: new Map(),
    pipelineEdge: new Map(),
    pipelineRun: new Map(),
    pipelineRunStep: new Map(),
  };
  let seq = 0;
  const id = (p: string) => `${p}_${(seq++).toString(36)}`;

  const matches = (row: Record<string, unknown>, where: unknown): boolean => {
    if (!where || typeof where !== 'object') return true;
    for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'in' in (v as object)) {
        if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };

  const delegate = (name: string) => {
    const t = tables[name]!;
    return {
      create: async ({ data }: { data: unknown }) => {
        const d = data as Record<string, unknown>;
        const rid = (d.id as string) ?? id(name);
        const row = { ...d, id: rid, startedAt: new Date(), sequenceIndex: d.sequenceIndex ?? 0 };
        t.set(rid, row);
        return row as { id: string };
      },
      createMany: async ({ data }: { data: unknown[] }) => {
        for (const d0 of data) {
          const d = d0 as Record<string, unknown>;
          const rid = (d.id as string) ?? id(name);
          t.set(rid, { ...d, id: rid });
        }
        return { count: data.length };
      },
      findUnique: async ({ where, include }: { where: unknown; include?: unknown }) => {
        const row = t.get((where as { id: string }).id);
        if (!row) return null;
        const out = { ...row };
        if (include && (include as Record<string, unknown>).nodes) {
          out.nodes = [...tables.pipelineNode!.values()].filter(
            (n) => n.pipelineId === row.id && !n.isDeleted
          );
        }
        if (include && (include as Record<string, unknown>).edges) {
          out.edges = [...tables.pipelineEdge!.values()].filter((e) => e.pipelineId === row.id);
        }
        return out;
      },
      findFirst: async ({ where, orderBy }: { where?: unknown; orderBy?: unknown }) => {
        let rows = [...t.values()].filter((r) => matches(r, where));
        if (orderBy && (orderBy as { sequenceIndex?: string }).sequenceIndex === 'desc') {
          rows = rows.sort((a, b) => (b.sequenceIndex as number) - (a.sequenceIndex as number));
        }
        return rows[0] ?? null;
      },
      findMany: async ({ where, take }: { where?: unknown; take?: number } = {}) => {
        let rows = [...t.values()].filter((r) => matches(r, where));
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        const rid = (where as { id: string }).id;
        const row = { ...t.get(rid), ...(data as object), id: rid } as Record<string, unknown>;
        t.set(rid, row);
        return row as { id: string };
      },
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        let n = 0;
        for (const [rid, row] of t) {
          if (matches(row, where)) {
            t.set(rid, { ...row, ...(data as object) });
            n++;
          }
        }
        return { count: n };
      },
      deleteMany: async ({ where }: { where: unknown }) => {
        let n = 0;
        for (const [rid, row] of t) {
          if (matches(row, where)) {
            t.delete(rid);
            n++;
          }
        }
        return { count: n };
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
    $executeRawUnsafe: async (_query, ...values) => {
      // Emulate the atomic cost UPDATE: last value is runId, first five are deltas.
      const [i, o, tot, dollars, calls, runId] = values as number[] & string[];
      const run = tables.pipelineRun!.get(runId as string);
      if (run) {
        const c = (run.cost as {
          tokens: Record<string, number>;
          dollars: number;
          llmCalls: number;
        }) ?? {
          tokens: { input: 0, output: 0, total: 0 },
          dollars: 0,
          llmCalls: 0,
        };
        run.cost = {
          tokens: {
            input: c.tokens.input + (i as number),
            output: c.tokens.output + (o as number),
            total: c.tokens.total + (tot as number),
          },
          dollars: c.dollars + (dollars as number),
          llmCalls: c.llmCalls + (calls as number),
        };
      }
      return 1;
    },
  };
  return client;
}

// ── Run a pipeline through the Prisma store ─────────────────────────────────
const store = new PrismaPipelineStore(createFakePrisma());
const engine = new PipelineEngine({
  store,
  llmFactory: { createModel: () => ({ invoke: async () => ({ content: '' }) }) },
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
    handler: async ({ n }) => ({
      kind: 'tool.double' as const,
      result: n * 2,
      positive: n * 2 > 0,
    }),
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

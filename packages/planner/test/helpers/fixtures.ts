import type { NodeSpec } from '@openpipeline/core';
import { z } from 'zod';

/** A TOOL spec with one required `text` input slot. */
export const echoSpec: NodeSpec = {
  key: 'tool.echo',
  nodeType: 'TOOL',
  displayName: 'Echo',
  description: 'Echoes the given text back out.',
  icon: 'text',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ kind: z.literal('tool.echo'), text: z.string() }),
  handler: (input: unknown) =>
    Promise.resolve({ kind: 'tool.echo' as const, text: (input as { text: string }).text }),
};

/** A second TOOL spec with one required `text` input slot. */
export const shoutSpec: NodeSpec = {
  key: 'tool.shout',
  nodeType: 'TOOL',
  displayName: 'Shout',
  description: 'Uppercases the given text.',
  icon: 'megaphone',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ kind: z.literal('tool.shout'), text: z.string() }),
  handler: (input: unknown) =>
    Promise.resolve({
      kind: 'tool.shout' as const,
      text: (input as { text: string }).text.toUpperCase(),
    }),
};

/** An IF spec, for validate.node.ts's IF-branch-rule tests. */
export const branchSpec: NodeSpec = {
  key: 'control.if',
  nodeType: 'IF',
  displayName: 'IF (branch)',
  description: 'Evaluates the previous output and routes true/false.',
  icon: 'git-branch',
  inputSchema: z.object({ condition: z.unknown().optional() }),
  outputSchema: z.object({ kind: z.literal('control.if'), branch: z.enum(['true', 'false']) }),
  handler: (input: unknown) =>
    Promise.resolve({
      kind: 'control.if' as const,
      branch: (input as { condition?: unknown }).condition ? ('true' as const) : ('false' as const),
    }),
};

/** An MCP-style spec with the generic unknown-output shape, for D5 auto-fill tests. */
export const mcpGenericSpec: NodeSpec = {
  key: 'mcp:demo:lookup',
  nodeType: 'MCP_TOOL',
  displayName: 'Demo - lookup',
  description: 'A tool with no declared output schema.',
  icon: 'puzzle',
  inputSchema: z.object({}),
  outputSchema: z.object({
    kind: z.literal('mcp_tool'),
    providerKey: z.string(),
    toolName: z.string(),
    output: z.unknown(),
  }),
  handler: () =>
    Promise.resolve({
      kind: 'mcp_tool' as const,
      providerKey: 'demo',
      toolName: 'lookup',
      output: {},
    }),
  meta: { mcp: { providerKey: 'demo', providerDisplayName: 'Demo', toolName: 'lookup' } },
};

/** A downstream TOOL spec with one required slot, for D5 auto-fill target tests. */
export const consumerSpec: NodeSpec = {
  key: 'tool.consume',
  nodeType: 'TOOL',
  displayName: 'Consume',
  description: 'Requires a single value input.',
  icon: 'download',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ kind: z.literal('tool.consume') }),
  handler: () => Promise.resolve({ kind: 'tool.consume' as const }),
};

/**
 * A spec whose `inputSchema` cannot be converted to JSON Schema by zod v4's
 * `z.toJSONSchema` (`z.custom()` is one of the exotic types it refuses by
 * default: "Custom types cannot be represented in JSON Schema"). Used to
 * drive `buildSpecCatalogText`'s fail-soft warning path (D2/D7) through a
 * full `plan()` run — see the I3 regression test in `planner.test.ts`.
 */
export const unconvertibleSpec: NodeSpec = {
  key: 'tool.unconvertible',
  nodeType: 'TOOL',
  displayName: 'Unconvertible',
  description: 'A spec whose input schema cannot be embedded in the design prompt.',
  icon: 'alert-triangle',
  inputSchema: z.custom<unknown>(() => true),
  outputSchema: z.object({ kind: z.literal('tool.unconvertible') }),
  handler: () => Promise.resolve({ kind: 'tool.unconvertible' as const }),
};

export const testSpecs: NodeSpec[] = [echoSpec, shoutSpec, branchSpec];

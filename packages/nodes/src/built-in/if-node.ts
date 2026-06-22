import { z } from 'zod';
import { defineNode, type NodeSpec, type IfNodeOutput } from '@openpipeline/core';

export const IfInputSchema = z.object({
  condition: z
    .unknown()
    .optional()
    .describe(
      'Value evaluated for truthiness. A state binding is recommended, e.g. outputs.<nodeId>.field'
    ),
});

export type IfInput = z.infer<typeof IfInputSchema>;

export const IfOutputSchema = z.object({
  kind: z.literal('control.if'),
  branch: z.enum(['true', 'false']),
}) as unknown as z.ZodType<IfNodeOutput>;

/** Built-in boolean branch node. Evaluates `condition` for truthiness. */
export function createIfNodeSpec(): NodeSpec<IfInput, IfNodeOutput> {
  return defineNode<IfInput, IfNodeOutput>({
    key: 'control.if',
    nodeType: 'IF',
    displayName: 'IF (branch)',
    description: 'Evaluates the previous output and routes to the true or false branch.',
    icon: 'git-branch',
    inputSchema: IfInputSchema,
    outputSchema: IfOutputSchema,
    handler: async (input) => ({
      kind: 'control.if',
      branch: input.condition ? 'true' : 'false',
    }),
  });
}

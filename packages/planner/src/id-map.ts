import type { GraphValidationIssue } from '@openpipeline/nodes';

import type { PlannerDraft } from './schema.js';

/**
 * Resolves LLM-facing short ids (e.g. "n1") to persisted UUIDs, reusing
 * `existingIdMap` entries so ids the model has seen before never change
 * across a correction loop (D4). `idMap` is the live, mutated map — read it
 * only *after* every `resolve()` call you intend to make has happened.
 */
export interface IdAssignment {
  idMap: Record<string, string>;
  // Property (arrow-function-typed), not interface method-shorthand: the
  // implementation below really is `this`-free, and declaring it this way
  // lets TypeScript prove that to callers that destructure `resolve` off the
  // returned object (method-shorthand syntax can't express that guarantee,
  // which is exactly what `@typescript-eslint/unbound-method` flags).
  resolve: (shortId: string) => string;
}

/**
 * Pre-resolves every short id referenced by `draft.nodes` and `draft.edges`
 * (including an edge endpoint that names no declared node — a "dangling
 * edge" — still gets a stable UUID so it can be rewritten back to its short
 * id in validation feedback). Callers that discover further short ids later
 * (e.g. inside a `state` binding path) can keep calling `resolve()`; the
 * returned `idMap` object is the same one mutated in place, so it always
 * reflects every resolution made through it.
 */
export function buildIdAssignment(
  draft: PlannerDraft,
  existingIdMap: Readonly<Record<string, string>>
): IdAssignment {
  const idMap: Record<string, string> = { ...existingIdMap };

  const resolve = (shortId: string): string => {
    const existing = idMap[shortId];
    if (existing !== undefined) return existing;
    const uuid = crypto.randomUUID();
    idMap[shortId] = uuid;
    return uuid;
  };

  for (const node of draft.nodes) resolve(node.id);
  for (const edge of draft.edges) {
    resolve(edge.from);
    resolve(edge.to);
  }

  return { idMap, resolve };
}

/**
 * Rewrite every persisted UUID occurring in `issues` (in `nodeId` and inside
 * `message`) back to its short id, using the reverse of `idMap`, and render
 * the result as a numbered list for the next design prompt (D4). An issue
 * whose `nodeId` has no entry in `idMap` (never resolved through
 * {@link buildIdAssignment}) is left as-is — defensive, should not happen in
 * practice since every id the design/validate nodes ever mint a
 * `GraphValidationIssue` for was resolved through the same `idMap`.
 */
export function buildDesignFeedback(
  issues: readonly GraphValidationIssue[],
  idMap: Readonly<Record<string, string>>
): string {
  const uuidToShortId = new Map<string, string>();
  for (const [shortId, uuid] of Object.entries(idMap)) uuidToShortId.set(uuid, shortId);

  const rewrite = (text: string): string => {
    let out = text;
    for (const [uuid, shortId] of uuidToShortId) {
      out = out.split(uuid).join(shortId);
    }
    return out;
  };

  return issues
    .map((issue, index) => {
      const nodeRef = issue.nodeId !== undefined ? ` node "${rewrite(issue.nodeId)}"` : '';
      const slotRef = issue.slot !== undefined ? ` (slot "${issue.slot}")` : '';
      return `${String(index + 1)}. [${issue.code}]${nodeRef}${slotRef}: ${rewrite(issue.message)}`;
    })
    .join('\n');
}

import { describe, expect, it } from 'vitest';

import { buildSelectPrompt } from '../src/prompts.js';

describe('buildSelectPrompt — D2b re-entry section (T3 review llm-robustness #2)', () => {
  const baseParams = {
    instruction: 'do something with a tool',
    taskSummary: 'a task summary',
    catalogText: '- key: "mcp:demo:lookup"\n  provider: "Demo"\n  description: ""',
  };

  it("omits the re-entry section entirely when `reentry` is not passed (select's first call this plan())", () => {
    const prompt = buildSelectPrompt(baseParams);
    expect(prompt).not.toContain('This is a correction');
  });

  it('names the unresolved key(s) that must be dropped or replaced when reentry.unresolvedKeys is non-empty', () => {
    const prompt = buildSelectPrompt({
      ...baseParams,
      reentry: { unresolvedKeys: ['mcp:demo:other'], resolvedKeys: [] },
    });
    expect(prompt).toContain('This is a correction');
    expect(prompt).toContain('mcp:demo:other');
    expect(prompt.toLowerCase()).toContain('do not reference them again');
  });

  it('names the already-resolved key(s) that do not need re-selecting when reentry.resolvedKeys is non-empty', () => {
    const prompt = buildSelectPrompt({
      ...baseParams,
      reentry: { unresolvedKeys: ['mcp:demo:other'], resolvedKeys: ['mcp:demo:lookup'] },
    });
    expect(prompt).toContain('mcp:demo:lookup');
    expect(prompt.toLowerCase()).toContain('already resolved');
  });

  it('produces a prompt strictly different from the no-reentry prompt for the same base params — proves this is not a byte-identical re-roll', () => {
    const firstPrompt = buildSelectPrompt(baseParams);
    const reentryPrompt = buildSelectPrompt({
      ...baseParams,
      reentry: { unresolvedKeys: ['mcp:demo:other'], resolvedKeys: ['mcp:demo:lookup'] },
    });
    expect(reentryPrompt).not.toBe(firstPrompt);
  });

  it('still lists the full catalog and the standard return-format instruction alongside the re-entry section', () => {
    const prompt = buildSelectPrompt({
      ...baseParams,
      reentry: { unresolvedKeys: ['mcp:demo:other'], resolvedKeys: [] },
    });
    expect(prompt).toContain('mcp:demo:lookup'); // from catalogText
    expect(prompt).toContain('Return the "mcp:<provider>:<tool>" keys you need');
  });
});

import { describe, it, expect } from 'vitest';

import { InMemoryOAuthStateStore } from '../src/oauth-store.js';

describe('InMemoryOAuthStateStore', () => {
  it('get returns undefined for an unknown key', async () => {
    const s = new InMemoryOAuthStateStore();
    expect(await s.get('nope')).toBeUndefined();
  });
  it('set then get round-trips a value', async () => {
    const s = new InMemoryOAuthStateStore();
    await s.set('k', { a: 1 });
    expect(await s.get<{ a: number }>('k')).toEqual({ a: 1 });
  });
  it('delete removes a key', async () => {
    const s = new InMemoryOAuthStateStore();
    await s.set('k', 'v');
    await s.delete('k');
    expect(await s.get('k')).toBeUndefined();
  });
});

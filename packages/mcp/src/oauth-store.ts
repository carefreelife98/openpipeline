/**
 * Pluggable async persistence seam for OAuth provider state. The package owns
 * the provider mechanics; the host owns WHERE state lives (DB, file, memory) by
 * supplying this. No framework/DB dependency enters @openpipeline/mcp.
 */

export interface OAuthStateStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Map-backed reference implementation (single-process, non-persistent). */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.has(key) ? (this.map.get(key) as T) : undefined);
  }

  set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

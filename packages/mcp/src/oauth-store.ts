/**
 * Pluggable async persistence seam for OAuth provider state. The package owns
 * the provider mechanics; the host owns WHERE state lives (DB, file, memory) by
 * supplying this. No framework/DB dependency enters @openpipeline/mcp.
 */

export interface OAuthStateStore {
  get<T>(key: string): Promise<T | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Map-backed reference implementation (single-process, non-persistent). */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly map = new Map<string, unknown>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.has(key) ? (this.map.get(key) as T) : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

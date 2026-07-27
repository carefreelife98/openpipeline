import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { OAuthStateStore } from './oauth-store.js';

export interface StoreBackedOAuthProviderOptions {
  /** Namespaces every store key for this MCP server. */
  serverKey: string;
  /** This client's registered redirect_uri (the host callback endpoint). */
  redirectUrl: string | URL;
  /** OAuth client metadata advertised during dynamic registration. */
  clientMetadata: OAuthClientMetadata;
}

/**
 * Implements the SDK `OAuthClientProvider` against an injected async store.
 * The SDK's `auth()` / transport drives the flow and calls these methods to
 * load/persist state — this class never performs discovery, PKCE math, or token
 * exchange itself. Host subclasses implement exactly the two genuinely
 * host-specific concerns: session identity and the redirect side effect.
 */
export abstract class StoreBackedOAuthProvider implements OAuthClientProvider {
  constructor(
    protected readonly store: OAuthStateStore,
    protected readonly opts: StoreBackedOAuthProviderOptions
  ) {}

  // ── host-specific (abstract) ───────────────────────────────────────────────
  /** Per-user/tenant namespace. Single-tenant hosts return a constant. */
  protected abstract getSessionId(): string | Promise<string>;
  /** Send the user agent to `url` (CLI prints, web 302s, popup postMessages). */
  abstract redirectToAuthorization(url: URL): void | Promise<void>;

  // ── static config ──────────────────────────────────────────────────────────
  get redirectUrl(): string | URL {
    return this.opts.redirectUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return this.opts.clientMetadata;
  }

  // ── store-backed state ─────────────────────────────────────────────────────
  // Segments are `encodeURIComponent`-escaped before joining so a `:` inside a
  // host-supplied session id (e.g. a composite `tenant:user` id) or serverKey
  // cannot make two distinct identities collide on the same store key — e.g.
  // session "a:b" + serverKey "c" vs. session "a" + serverKey "b:c" must not
  // both resolve to "a:b:c:tokens".
  private async key(suffix: string): Promise<string> {
    const sessionId = await this.getSessionId();
    return [sessionId, this.opts.serverKey, suffix].map(encodeURIComponent).join(':');
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.store.get<OAuthTokens>(await this.key('tokens'));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.set(await this.key('tokens'), tokens);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.store.get<OAuthClientInformationMixed>(await this.key('client'));
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.set(await this.key('client'), info);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(await this.key('verifier'), verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get<string>(await this.key('verifier'));
    if (v == null) {
      throw new Error(`[mcp-oauth] no code verifier saved for "${this.opts.serverKey}"`);
    }
    return v;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.store.set(await this.key('discovery'), state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.store.get<OAuthDiscoveryState>(await this.key('discovery'));
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    const targets: string[] =
      scope === 'all' ? ['tokens', 'client', 'verifier', 'discovery'] : [scope];
    for (const t of targets) {
      await this.store.delete(await this.key(t));
    }
  }
}

import type { OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, it, expect } from 'vitest';

import { StoreBackedOAuthProvider } from '../src/oauth-provider-base.js';
import type { StoreBackedOAuthProviderOptions } from '../src/oauth-provider-base.js';
import { InMemoryOAuthStateStore } from '../src/oauth-store.js';
import type { OAuthStateStore } from '../src/oauth-store.js';

const META: OAuthClientMetadata = {
  redirect_uris: ['http://localhost:3000/cb'],
  client_name: 'test',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

// Concrete test subclass: configurable session id (default 'sid1'), captures redirect URL.
class TestProvider extends StoreBackedOAuthProvider {
  public redirected?: URL;
  constructor(
    store: OAuthStateStore,
    opts: StoreBackedOAuthProviderOptions,
    private readonly sessionId: string = 'sid1'
  ) {
    super(store, opts);
  }
  protected getSessionId() {
    return this.sessionId;
  }
  redirectToAuthorization(url: URL) {
    this.redirected = url;
  }
}

function make() {
  const store = new InMemoryOAuthStateStore();
  const p = new TestProvider(store, {
    serverKey: 'github',
    redirectUrl: 'http://localhost:3000/cb',
    clientMetadata: META,
  });
  return { store, p };
}

describe('StoreBackedOAuthProvider', () => {
  it('exposes redirectUrl + clientMetadata from opts', () => {
    const { p } = make();
    expect(String(p.redirectUrl)).toBe('http://localhost:3000/cb');
    expect(p.clientMetadata.client_name).toBe('test');
  });

  it('tokens round-trip through the store, namespaced by session+server', async () => {
    const { store, p } = make();
    expect(await p.tokens()).toBeUndefined();
    const t: OAuthTokens = { access_token: 'a', token_type: 'bearer' };
    await p.saveTokens(t);
    expect(await p.tokens()).toEqual(t);
    // stored under a key that includes session + serverKey
    expect(await store.get('sid1:github:tokens')).toEqual(t);
  });

  it('codeVerifier throws if none saved (SDK contract), returns it after save', async () => {
    const { p } = make();
    await expect(p.codeVerifier()).rejects.toThrow();
    await p.saveCodeVerifier('verifier123');
    expect(await p.codeVerifier()).toBe('verifier123');
  });

  it('clientInformation + discoveryState round-trip', async () => {
    const { p } = make();
    expect(await p.clientInformation()).toBeUndefined();
    await p.saveClientInformation({ client_id: 'cid' });
    expect((await p.clientInformation())?.client_id).toBe('cid');
    expect(await p.discoveryState()).toBeUndefined();
    await p.saveDiscoveryState({ authorizationServerUrl: 'https://as' });
    expect(await p.discoveryState()).toBeTruthy();
  });

  it('invalidateCredentials("tokens") deletes only tokens', async () => {
    const { p } = make();
    await p.saveTokens({ access_token: 'a', token_type: 'bearer' });
    await p.saveClientInformation({ client_id: 'cid' });
    await p.invalidateCredentials('tokens');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeTruthy();
  });

  it('redirectToAuthorization is delegated to the subclass', () => {
    const { p } = make();
    p.redirectToAuthorization(new URL('https://as/authorize?x=1'));
    expect(p.redirected?.searchParams.get('x')).toBe('1');
  });

  it('escapes ":" in session id / serverKey so composite identities cannot collide', async () => {
    // session "a:b" + serverKey "c" and session "a" + serverKey "b:c" would both
    // naively join to "a:b:c:tokens" if segments were not escaped before joining.
    const store = new InMemoryOAuthStateStore();
    const p1 = new TestProvider(
      store,
      { serverKey: 'c', redirectUrl: 'http://localhost:3000/cb', clientMetadata: META },
      'a:b'
    );
    const p2 = new TestProvider(
      store,
      { serverKey: 'b:c', redirectUrl: 'http://localhost:3000/cb', clientMetadata: META },
      'a'
    );

    const t1: OAuthTokens = { access_token: 'p1-token', token_type: 'bearer' };
    await p1.saveTokens(t1);

    expect(await p1.tokens()).toEqual(t1);
    expect(await p2.tokens()).toBeUndefined();
  });
});

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { McpServerConfig } from './types.js';

export interface PolicyContext {
  userId?: string;
  tenantId?: string;
}

export interface PolicyTool {
  name: string;
  description?: string;
}

/**
 * Optional policy that inverts the Mate-X 3-tier permission model
 * (super-admin provider registration -> company admin activation -> per-user
 * connection) without baking it into core.
 *
 * - filterProviders: which servers are visible (admin curation / company activation)
 * - filterTools: which tools within a provider are allowed (the company allowlist)
 * - resolveToken: per-user OAuth token resolution (static bearer token)
 * - resolveAuthProvider: per-server live OAuth provider (full dynamic flow via SDK)
 *
 * The single-tenant default (no policy) returns everything and uses the token
 * from each server config — i.e. "personal direct use". Multi-tenant hosts
 * implement these methods; the engine never sees companyId or scope.
 *
 * Auth precedence: resolveAuthProvider > resolveToken > server.accessToken.
 * When resolveAuthProvider returns a provider, resolveToken is NOT consulted.
 */
export interface CatalogPolicy {
  filterProviders?(
    servers: readonly McpServerConfig[],
    ctx: PolicyContext
  ): McpServerConfig[] | Promise<McpServerConfig[]>;
  filterTools?(
    tools: readonly PolicyTool[],
    server: McpServerConfig,
    ctx: PolicyContext
  ): PolicyTool[] | Promise<PolicyTool[]>;
  resolveToken?(
    server: McpServerConfig,
    ctx: PolicyContext
  ): string | undefined | Promise<string | undefined>;
  /**
   * Per-server live OAuth provider. When present, the SDK transport drives the
   * full flow (401 → refresh → retry) via the provider's tokens()/saveTokens().
   * Takes precedence over resolveToken. Return undefined to fall through to
   * resolveToken / server.accessToken.
   */
  resolveAuthProvider?(
    server: McpServerConfig,
    ctx: PolicyContext
  ): OAuthClientProvider | undefined | Promise<OAuthClientProvider | undefined>;
}

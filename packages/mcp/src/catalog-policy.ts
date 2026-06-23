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
 * - resolveToken: per-user OAuth token resolution
 *
 * The single-tenant default (no policy) returns everything and uses the token
 * from each server config — i.e. "personal direct use". Multi-tenant hosts
 * implement these three methods; the engine never sees companyId or scope.
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
}

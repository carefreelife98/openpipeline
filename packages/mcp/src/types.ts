// Plain config types replacing the Mate-X Prisma `McpProvider`. A host describes
// its MCP servers with these — no database required.

export type McpTransportType = 'http' | 'stdio';
export type McpAuthType = 'none' | 'oauth_preregistered' | 'oauth_dynamic';

export interface McpServerConfig {
  /** Stable provider key, used in node keys: `mcp:<key>:<tool>`. */
  key: string;
  /** User-facing name. Defaults to `key`. */
  displayName?: string;
  iconUrl?: string;
  transportType: McpTransportType;

  // http transport
  url?: string;

  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  authType?: McpAuthType;
  /** Pre-obtained access token for `oauth_preregistered`. */
  accessToken?: string;

  /** Optional service-wide tool allowlist (the upper bound). null/undefined = all tools. */
  allowedTools?: string[] | null;
}

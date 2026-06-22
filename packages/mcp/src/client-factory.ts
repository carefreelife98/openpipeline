import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredTool } from '@langchain/core/tools';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServerConfig } from './types.js';

/**
 * Injects a pre-obtained OAuth token at the MCP protocol level. Some servers
 * (e.g. HubSpot) require MCP-level OAuth rather than plain headers.
 */
export class PreObtainedTokenAuthProvider implements OAuthClientProvider {
  private currentTokens: OAuthTokens;
  private clientInfo: OAuthClientInformationFull | undefined;

  constructor(accessToken: string) {
    this.currentTokens = { access_token: accessToken, token_type: 'bearer' };
  }

  get redirectUrl() {
    return 'http://localhost:0/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: ['http://localhost:0/callback'],
      client_name: 'OpenPipeline MCP Client',
      logo_uri: '',
      tos_uri: '',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = info;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.currentTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.currentTokens = tokens;
  }

  async redirectToAuthorization(): Promise<void> {
    // server-side — no redirect; token already held
  }

  async saveCodeVerifier(): Promise<void> {
    // PKCE not needed — token already held
  }

  async codeVerifier(): Promise<string> {
    return '';
  }
}

/** Create a MultiServerMCPClient for a single server config. */
export function createClient(config: McpServerConfig, accessToken?: string): MultiServerMCPClient {
  const serverConfig =
    config.transportType === 'http'
      ? {
          url: config.url!,
          ...(accessToken ? { authProvider: new PreObtainedTokenAuthProvider(accessToken) } : {}),
        }
      : {
          transport: 'stdio' as const,
          command: config.command!,
          args: config.args ?? [],
          ...(config.env ? { env: config.env } : {}),
        };

  return new MultiServerMCPClient({ mcpServers: { [config.key]: serverConfig } });
}

/** Get the LangChain tools for a client, filtered by the effective allowlist. */
export async function getFilteredTools(
  client: MultiServerMCPClient,
  allowedTools: string[] | null | undefined
): Promise<StructuredTool[]> {
  const tools = await client.getTools();
  if (allowedTools == null) return tools;
  const allow = new Set(allowedTools);
  return tools.filter((t) => allow.has(t.name));
}

/**
 * Raw `listTools()` to extract original input/output JSON Schemas. The adapter's
 * DynamicStructuredTool conversion drops `outputSchema` and flattens unions, so
 * for accurate schemas we read the raw protocol response.
 */
export async function getRawSchemas(
  client: MultiServerMCPClient,
  serverKey: string
): Promise<{ inputSchemas: Map<string, unknown>; outputSchemas: Map<string, unknown> }> {
  const inputSchemas = new Map<string, unknown>();
  const outputSchemas = new Map<string, unknown>();
  try {
    const rawClient = await (
      client as unknown as {
        getClient: (serverName: string) => Promise<{
          listTools: () => Promise<{
            tools: Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown }>;
            nextCursor?: string;
          }>;
        }>;
      }
    ).getClient(serverKey);

    let cursor: string | undefined;
    do {
      const resp = await rawClient.listTools();
      for (const t of resp.tools ?? []) {
        if (t.inputSchema != null) inputSchemas.set(t.name, t.inputSchema);
        if (t.outputSchema != null) outputSchemas.set(t.name, t.outputSchema);
      }
      cursor = resp.nextCursor;
    } while (cursor);
  } catch {
    // Raw access failed — caller falls back to adapter results.
  }
  return { inputSchemas, outputSchemas };
}

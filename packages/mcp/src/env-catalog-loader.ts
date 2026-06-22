import {
  NOOP_LOGGER,
  type CatalogLoader,
  type CatalogResult,
  type ResolvedProvider,
  type ResolvedTool,
  type Logger,
} from '@openpipeline/core';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredTool } from '@langchain/core/tools';
import type { McpServerConfig } from './types.js';
import type { CatalogPolicy, PolicyContext } from './catalog-policy.js';
import { createClient, getFilteredTools, getRawSchemas } from './client-factory.js';

export interface EnvCatalogLoaderOptions {
  servers: McpServerConfig[];
  /** Optional multi-tenant policy. Omit for single-tenant "personal direct use". */
  policy?: CatalogPolicy;
  logger?: Logger;
}

/** Unwrap the MCP `tools/call` response, preferring `structuredContent`. */
function unwrapToolResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'structuredContent' in raw) {
    return (raw as { structuredContent: unknown }).structuredContent;
  }
  return raw;
}

/**
 * The default single-tenant CatalogLoader. Reads MCP servers from config (the
 * "env" pattern), connects to each, and exposes their tools. With no policy it
 * returns everything and uses each server's configured token — personal direct
 * use. A CatalogPolicy layers admin curation / allowlists / per-user OAuth on top
 * without changing this loader.
 */
export function createEnvCatalogLoader(options: EnvCatalogLoaderOptions): CatalogLoader {
  const logger = options.logger ?? NOOP_LOGGER;

  return {
    async load(ctx): Promise<CatalogResult> {
      const policyCtx: PolicyContext = { userId: ctx.userId, tenantId: ctx.tenantId };

      const servers = options.policy?.filterProviders
        ? await options.policy.filterProviders(options.servers, policyCtx)
        : options.servers;

      const clients: MultiServerMCPClient[] = [];
      const providers: ResolvedProvider[] = [];

      for (const server of servers) {
        const token =
          (options.policy?.resolveToken
            ? await options.policy.resolveToken(server, policyCtx)
            : undefined) ?? server.accessToken;

        let client: MultiServerMCPClient;
        try {
          client = createClient(server, server.authType === 'none' ? undefined : token);
          clients.push(client);
        } catch (err) {
          logger.warn(`[mcp] failed to create client for "${server.key}"`, { err });
          continue;
        }

        let tools: StructuredTool[];
        try {
          tools = await getFilteredTools(client, server.allowedTools);
        } catch (err) {
          logger.warn(`[mcp] failed to list tools for "${server.key}"`, { err });
          continue;
        }

        // Apply tool-level policy (allowlist).
        if (options.policy?.filterTools) {
          const allowed = await options.policy.filterTools(
            tools.map((t) => ({ name: t.name, description: t.description })),
            server,
            policyCtx
          );
          const allowSet = new Set(allowed.map((t) => t.name));
          tools = tools.filter((t) => allowSet.has(t.name));
        }

        // Original schemas (the adapter drops outputSchema and flattens unions).
        const { inputSchemas, outputSchemas } = await getRawSchemas(client, server.key);

        const resolvedTools: ResolvedTool[] = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchemas.get(tool.name),
          outputSchema: outputSchemas.get(tool.name),
          invoke: async (input: unknown) => {
            // Surface real validation errors instead of the adapter's generic message.
            (tool as { verboseParsingErrors?: boolean }).verboseParsingErrors = true;
            const raw = await tool.invoke(input as never);
            return unwrapToolResult(raw);
          },
        }));

        providers.push({
          key: server.key,
          displayName: server.displayName ?? server.key,
          iconUrl: server.iconUrl,
          tools: resolvedTools,
        });
      }

      return {
        providers,
        cleanup: async () => {
          await Promise.all(
            clients.map((c) =>
              (c as { close?: () => Promise<void> }).close?.().catch((err) => {
                logger.warn('[mcp] client cleanup failed', { err });
              })
            )
          );
        },
      };
    },
  };
}

import type { StructuredTool } from '@langchain/core/tools';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import {
  NOOP_LOGGER,
  type CatalogLoader,
  type CatalogResult,
  type ResolvedProvider,
  type ResolvedTool,
  type Logger,
} from '@openpipeline/core';

import type { CatalogPolicy, PolicyContext } from './catalog-policy.js';
import { createClient, getFilteredTools, getRawSchemas } from './client-factory.js';
import type { McpServerConfig } from './types.js';

export interface EnvCatalogLoaderOptions {
  servers: McpServerConfig[];
  /** Optional multi-tenant policy. Omit for single-tenant "personal direct use". */
  policy?: CatalogPolicy;
  logger?: Logger;
}

/** Unwrap the MCP `tools/call` response, preferring `structuredContent`. */
function unwrapToolResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'structuredContent' in raw) {
    return raw.structuredContent;
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

      // Quality-batch item 3: everything from `createClient` onward for a
      // given server runs inside this try — the per-server
      // createClient/getFilteredTools try/catches below are a DIFFERENT,
      // intentional kind of failure (a soft "skip this one server, keep
      // going" degradation), but a failure that escapes ALL of those (e.g.
      // `getRawSchemas` rejecting, unguarded, for a LATER server after
      // earlier servers' clients are already open) must not leak the clients
      // already pushed onto `clients` — `cleanup` is only ever returned
      // below, on a fully successful `load()`, so nothing else would ever
      // call `.close()` on them once this throws past the loop.
      try {
        for (const server of servers) {
          const authProvider = options.policy?.resolveAuthProvider
            ? await options.policy.resolveAuthProvider(server, policyCtx)
            : undefined;

          const token = authProvider
            ? undefined
            : ((options.policy?.resolveToken
                ? await options.policy.resolveToken(server, policyCtx)
                : undefined) ?? server.accessToken);

          let client: MultiServerMCPClient;
          try {
            const auth = server.authType === 'none' ? undefined : (authProvider ?? token);
            client = createClient(server, auth);
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
              // LangChain's `invoke` is typed to return `any` (ToolOutputType = any);
              // pin it to `unknown` at this boundary so callers can't treat it unsafely.
              const raw: unknown = await tool.invoke(input);
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
      } catch (err) {
        // Best-effort close of every client opened so far, mirroring the
        // returned `cleanup` closure's own "log, never throw" semantics
        // below — a close failure here must never mask the ORIGINAL load
        // error being rethrown.
        await Promise.all(
          clients.map((c) =>
            c.close().catch((closeErr: unknown) => {
              logger.warn('[mcp] client cleanup failed after a mid-load error', { closeErr });
            })
          )
        );
        throw err;
      }

      return {
        providers,
        cleanup: async () => {
          await Promise.all(
            clients.map((c) =>
              c.close().catch((err: unknown) => {
                logger.warn('[mcp] client cleanup failed', { err });
              })
            )
          );
        },
      };
    },
  };
}

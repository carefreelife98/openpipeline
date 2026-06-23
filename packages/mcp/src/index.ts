// @openpipeline/mcp — optional MCP integration.
// Single-tenant by default (personal direct use); a CatalogPolicy adds
// multi-tenant curation / allowlists / per-user OAuth without touching core.

export type { McpServerConfig, McpTransportType, McpAuthType } from './types.js';
export {
  McpSchemaConverter,
  type McpSchemaConversionResult,
  type ConversionFailureReason,
  type ConvertOptions,
} from './schema-converter.js';
export {
  createClient,
  getFilteredTools,
  getRawSchemas,
  PreObtainedTokenAuthProvider,
} from './client-factory.js';
export type { CatalogPolicy, PolicyContext, PolicyTool } from './catalog-policy.js';
export { createEnvCatalogLoader, type EnvCatalogLoaderOptions } from './env-catalog-loader.js';
export { McpNodeResolverImpl, parseMcpKey, type ParsedMcpKey } from './node-resolver.js';

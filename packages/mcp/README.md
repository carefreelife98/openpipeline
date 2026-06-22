# @openworkflow/mcp

Optional MCP integration for OpenWorkflow: JSON-Schema→Zod converter, MCP client factory, env catalog loader, and mcp:* node resolver.

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/mcp
```

## Usage

Optional MCP integration: a JSON-Schema→Zod converter, an MCP client factory, an env-based `CatalogLoader`, and the `mcp:<provider>:<tool>` node resolver. Single-tenant by default; a `CatalogPolicy` adds admin curation / allowlists / per-user OAuth.

```ts
import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openworkflow/mcp';
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT

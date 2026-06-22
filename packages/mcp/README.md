# @openpipeline/mcp

Optional MCP integration for OpenPipeline: JSON-Schema→Zod converter, MCP client factory, env catalog loader, and mcp:\* node resolver.

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/mcp
```

## Usage

Optional MCP integration: a JSON-Schema→Zod converter, an MCP client factory, an env-based `CatalogLoader`, and the `mcp:<provider>:<tool>` node resolver. Single-tenant by default; a `CatalogPolicy` adds admin curation / allowlists / per-user OAuth.

```ts
import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openpipeline/mcp';
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT

import react from '@vitejs/plugin-react';
import { defineConfig, type Connect } from 'vite';

import { createBackend } from './backend.js';

/**
 * Mounts the OpenPipeline backend as Vite dev middleware so `pnpm dev` serves
 * both the API (`/pipeline/*`, `/catalog`) and the React app from one process.
 */
function openpipelineApi() {
  return {
    name: 'openpipeline-api',
    configureServer(server: { middlewares: Connect.Server }) {
      const { catalog, httpHandler, seedId } = createBackend();
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url.startsWith('/catalog')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(catalog));
          return;
        }
        if (url === '/seed') {
          res.setHeader('Content-Type', 'application/json');
          void Promise.resolve(seedId).then((id) => res.end(JSON.stringify({ pipelineId: id })));
          return;
        }
        if (url.startsWith('/pipeline')) {
          httpHandler(req, res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), openpipelineApi()],
  server: { port: 5173 },
});

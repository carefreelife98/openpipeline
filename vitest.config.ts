import { defineConfig } from 'vitest/config';

// Single root config covering every package. Tests live in each package's
// `test/` dir (sibling of `src/`), outside the published `dist/`. Unit tests
// import package source via `../src/...` relative paths (no build needed); the
// engine integration test imports the built `@openpipeline/*` packages (run
// `pnpm build` first — CI does), so it exercises the real published artifacts.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.{ts,tsx}'],
    // Node by default; the React package's tests opt into jsdom per-file with a
    // `// @vitest-environment jsdom` docblock (only those need a DOM).
    environment: 'node',
    // Registers jest-dom matchers + auto-cleanup for component tests.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/generated/**'],
      // Per-package floors set just BELOW the measured coverage of packages
      // that have tests — a regression gate, not an aspiration. nodes/runtime
      // (hardest code = the LangGraph integration) are covered by the runtime
      // integration test rather than unit-gated. The React canvas floor is
      // modest because DeletableEdge's component body only renders inside a real
      // <ReactFlow> graph (jsdom can't measure it) — its branch logic is unit-
      // tested via the extracted edge-label helper, and a full edge render +
      // delete-click is a tracked E2E follow-up. Raise these as coverage grows.
      thresholds: {
        'packages/core/src/**': { lines: 55, functions: 25, branches: 70 },
        'packages/mcp/src/**': { lines: 55, functions: 40, branches: 55 },
        'packages/server/src/**': { lines: 95, functions: 95, branches: 80 },
        'packages/store-memory/src/**': { lines: 95, functions: 90, branches: 85 },
        'packages/store-prisma/src/**': { lines: 95, functions: 95, branches: 90 },
        'packages/react/src/lib/**': { lines: 90, functions: 90, branches: 90 },
        'packages/react/src/store/**': { lines: 95, functions: 95, branches: 90 },
        'packages/react/src/canvas/**': { lines: 55, functions: 75, branches: 35 },
      },
    },
  },
});

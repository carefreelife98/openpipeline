// ESLint 9+ flat config for OpenPipeline.
//
// Layers: typescript-eslint strictTypeChecked (type-aware) over the kernel +
// adapter source, import-x ordering, a React block scoped to the visual
// builder, and eslint-config-prettier LAST so formatting is owned by Prettier.
//
// Type-aware linting needs a TS program; this uses a dedicated
// tsconfig.eslint.json that covers src + tests + root configs. The
// `prisma/src/generated` dir and all build output are ignored.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Global ignores — build output, generated client, deps, coverage, docs.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.claude/**',
      'coverage/**',
      'packages/store-prisma/src/generated/**',
      'docs/**',
    ],
  },

  // Base JS recommended.
  js.configs.recommended,

  // Type-aware strict rules for all TS/TSX.
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Single ESLint-only program covering src + test + root tooling configs
        // (tsconfig.eslint.json). The per-package build tsconfigs only see
        // src/**, so a dedicated lint program is how type-aware rules reach the
        // test files too.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Import ordering (ESM-aware via import-x).
  {
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [{ pattern: '@openpipeline/**', group: 'internal', position: 'before' }],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
    },
  },

  // Project conventions: consistent type imports (aligns with verbatimModuleSyntax),
  // and allow intentional unused vars prefixed with _.
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // React block — only the visual builder + the playground app.
  {
    files: ['packages/react/**/*.{ts,tsx}', 'examples/playground/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // automatic JSX runtime
      'react/prop-types': 'off', // TypeScript handles prop typing
    },
  },

  // Prettier LAST — turn off all formatting rules ESLint would otherwise enforce.
  prettier
);

// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/', '**/.wrangler/', 'data/']),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // packages/core must run unchanged on Node and Cloudflare Workers.
    // So does everything the API bundles for Workers (ADR-0013).
    files: [
      'packages/core/src/**/*.ts',
      'packages/db/src/*.ts',
      'packages/db/src/workers/**/*.ts',
      'packages/evals/src/runtime.ts',
      'packages/evals/src/runtime-io.ts',
      'packages/evals/src/answer-runtime.ts',
      'apps/api/src/**/*.ts',
    ],
    ignores: ['apps/api/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Runtime-agnostic code (Node + Workers): no Node APIs.' }] },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', '__filename', 'require'],
    },
  },
);

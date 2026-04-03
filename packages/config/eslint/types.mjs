// Shared ESLint config for the `packages/types` package.
// Keeps contract files strict and consistent across schemas, interfaces, and exports.

import { baseConfig } from './base.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
];

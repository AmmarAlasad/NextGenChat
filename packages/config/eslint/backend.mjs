// Shared backend ESLint config.
// Builds on the workspace baseline and leaves room for Node/Fastify-specific overrides.

import { baseConfig } from './base.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

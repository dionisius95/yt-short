import { defineWorkspace } from 'vitest/config';
import path from 'path';

export default defineWorkspace([
  // Unit test suite
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      globals: true,
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
        '@electron': path.resolve(__dirname, 'electron'),
      },
    },
  },

  // Property-based test suite
  {
    extends: './vitest.config.ts',
    test: {
      name: 'property',
      include: ['tests/property/**/*.test.ts'],
      environment: 'node',
      globals: true,
      // Property tests may run longer due to many generated inputs
      testTimeout: 60000,
      hookTimeout: 30000,
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
        '@electron': path.resolve(__dirname, 'electron'),
      },
    },
  },

  // Integration test suite
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      globals: true,
      // Integration tests may be slower (real DB, real processes)
      testTimeout: 120000,
      hookTimeout: 60000,
      // Run integration tests sequentially to avoid resource contention
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
        '@electron': path.resolve(__dirname, 'electron'),
      },
    },
  },
]);

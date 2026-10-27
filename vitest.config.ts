import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const swcPlugin = swc.vite({
  swcrc: false,
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },
    target: 'es2023',
    keepClassNames: true,
  },
  module: { type: 'es6' },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/worker.ts', 'src/**/*.spec.ts'],
      reporter: ['text-summary', 'lcov'],
    },
    projects: [
      {
        plugins: [swcPlugin],
        test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e.ts'],
          environment: 'node',
          globalSetup: ['test/setup/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          pool: 'forks',
          fileParallelism: true,
        },
      },
    ],
  },
});

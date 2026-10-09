import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/auth/**/*.ts',
        'src/health/**/*.ts',
        'src/common/guards/**/*.ts',
        'src/common/filters/**/*.ts',
        'src/common/interceptors/**/*.ts',
        'src/common/utils/**/*.ts',
        'src/common/config/**/*.ts',
        'src/common/throttler/**/*.ts',
        'src/redis/**/*.ts',
        'src/users/**/*.ts',
      ],
      exclude: ['src/**/*.spec.ts', 'src/**/*.module.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 55,
      },
    },
  },
});

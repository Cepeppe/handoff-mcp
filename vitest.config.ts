import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Canaries run against a real agent and are driven by canary.yml, never by `pnpm test`.
    exclude: ['test/canary/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});

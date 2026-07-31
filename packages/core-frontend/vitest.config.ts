import { defineConfig } from 'vitest/config';
import path from 'node:path';

// `protected.ts` (shared) requires DEFAULT_BRANCH / PROTECTED_BRANCHES with no
// fallback. Tests read them from `process.env` at runtime (there's no Vite
// `define` under vitest), so pin the historical two-branch values here.
process.env.DEFAULT_BRANCH = 'target-company-state';
process.env.PROTECTED_BRANCHES = 'current-company-state,target-company-state';

export default defineConfig({
  resolve: {
    alias: {
      '@bevel-software/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
  },
});

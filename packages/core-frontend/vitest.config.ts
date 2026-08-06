import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The branch model is applied by `src/test-setup.ts` via
// `configureBranchModel`, the same call the browser makes after fetching
// `/api/config` — no environment pinning needed here any more.

export default defineConfig({
  resolve: {
    alias: {
      '@bevel-software/platform-shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
  },
});

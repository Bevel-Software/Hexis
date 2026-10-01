import { defineConfig } from 'vitest/config';

// The shell's own tests: what it adds on top of the core package (the pino
// sink, today). They run against the BUILT core package, as the shell does.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});

import { defineConfig } from '@playwright/test';

/**
 * The real-browser suite of core-frontend: the few assertions that cross a
 * boundary the unit suite's happy-dom does not have — layout, a sandboxed
 * iframe, `postMessage` between the two — and so must be made in a browser
 * (Round-Trip Through the Real Intermediary). Everything else stays in
 * vitest; this runner is for what a stand-in document cannot answer.
 *
 * Run with `pnpm test:browser`, after `playwright install chromium` once;
 * CI installs the browser and runs it beside the unit suites. No server:
 * every page here is set from a string.
 *
 * A suite lives where its imports allow: here when it reaches the app only
 * through module entries, and in a module's own `__tests__/browser/` when it
 * drives that module's files (a module's suites may import its files; no
 * other suite may). The runner collects both.
 */
export default defineConfig({
  testDir: '..',
  testMatch: ['browser/**/*.browser.ts', 'src/**/__tests__/browser/**/*.browser.ts'],
  outputDir: '../node_modules/.playwright/test-results',
  reporter: 'list',
  timeout: 30_000,
  fullyParallel: true,
  use: {
    browserName: 'chromium',
    headless: true,
  },
});

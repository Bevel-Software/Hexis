import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { build, type Rollup } from 'vite';
import type { buildSandboxedHtml, sanitizeAgentHtml } from '../../src/modules/workspace/components/renderers/htmlSandbox';

/**
 * Build a page's frame document IN the browser under test, with the real
 * `buildSandboxedHtml`. The builder lists the frame's scripts by parsing the
 * document with `DOMParser`, which the test runner's Node does not have, and
 * which should be the same browser's parser as the frame's anyway.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type BuildOptions = Parameters<typeof buildSandboxedHtml>[0];
/** What `sandbox-builder.ts` puts on the window. */
type WithBuilder = { htmlSandbox?: { buildSandboxedHtml: typeof buildSandboxedHtml; sanitizeAgentHtml: typeof sanitizeAgentHtml } };

let builderBundle: Promise<string> | undefined;
/** `sandbox-builder.ts`, bundled once per worker. */
function bundle(): Promise<string> {
  builderBundle ??= (async () => {
    const built = (await build({
      configFile: false,
      root: here,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve(here, 'sandbox-builder.ts'), formats: ['iife'], name: 'SandboxBuilder', fileName: () => 'sandbox-builder.js' },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = Array.isArray(built) ? built : [built];
    const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
    if (!chunk) throw new Error('the sandbox builder bundle produced no chunk');
    return chunk.code;
  })();
  return builderBundle;
}

/** Load the builder into the page's current document, once. */
async function loadBuilder(page: Page): Promise<void> {
  if (await page.evaluate(() => typeof (window as WithBuilder).htmlSandbox === 'object')) return;
  await page.addScriptTag({ content: await bundle() });
}

/** `buildSandboxedHtml(opts)`, run in `page`. */
export async function buildSandboxedHtmlIn(page: Page, opts: BuildOptions): Promise<string> {
  await loadBuilder(page);
  return page.evaluate((o) => (window as WithBuilder).htmlSandbox!.buildSandboxedHtml(o), opts);
}

/** `sanitizeAgentHtml(html)`, run in `page`. */
export async function sanitizeAgentHtmlIn(page: Page, html: string): Promise<string> {
  await loadBuilder(page);
  return page.evaluate((h) => (window as WithBuilder).htmlSandbox!.sanitizeAgentHtml(h), html);
}

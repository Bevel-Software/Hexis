import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { build, type Rollup } from 'vite';

/**
 * The one way a browser suite gets its page: a fixture under `fixtures/`,
 * bundled by vite into a script a page set from a string can run, and, for a
 * suite that asks about layout, the app's stylesheet built for the classes
 * that script names. Every suite bundles through here, so a change to how a
 * harness is built is made once.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const bundles = new Map<string, Promise<string>>();

/**
 * `fixtures/<entry>`, bundled as one classic script, once per worker: the
 * fixture installs what the suite drives on `window` itself.
 */
export function bundleFixture(entry: string): Promise<string> {
  let bundle = bundles.get(entry);
  if (!bundle) {
    bundle = buildFixture(entry);
    bundles.set(entry, bundle);
    // A failed build is not kept: the next ask builds again.
    bundle.catch(() => bundles.delete(entry));
  }
  return bundle;
}

async function buildFixture(entry: string): Promise<string> {
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures', entry), formats: ['iife'], name: 'BrowserHarness', fileName: () => 'harness.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  // One output per format asked for; one format was asked for.
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error(`the bundle of fixtures/${entry} produced no chunk`);
  return chunk.code;
}

const stylesheets = new Map<string, Promise<string>>();

/**
 * The app's stylesheet for `fixtures/<entry>`: Tailwind and the design tokens
 * (`src/shared/theme`), built for every class the fixture's bundle names. The
 * typography plugin is left out: no harness renders the Markdown renderer.
 */
export function appStylesheet(entry: string): Promise<string> {
  let sheet = stylesheets.get(entry);
  if (!sheet) {
    sheet = buildStylesheet(entry);
    stylesheets.set(entry, sheet);
    sheet.catch(() => stylesheets.delete(entry));
  }
  return sheet;
}

async function buildStylesheet(entry: string): Promise<string> {
  const themeDir = path.resolve(here, '../src/shared/theme');
  const tailwindCss = require.resolve('tailwindcss/index.css');
  const compiled = await compile(`@import 'tailwindcss';\n@import './index.css';\n`, {
    base: themeDir,
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? tailwindCss : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  // Every token in the bundle is a candidate; Tailwind keeps the utilities.
  const candidates = Array.from(new Set((await bundleFixture(entry)).split(/[\s"'`,;{}()<>=]+/).filter(Boolean)));
  return compiled.build(candidates);
}

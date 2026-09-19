/**
 * Resolve an element's utility classes to the declarations a browser would
 * actually apply, by compiling THIS project's stylesheet with THIS project's
 * Tailwind.
 *
 * `toHaveClass('truncate')` is not a layout assertion: happy-dom loads no
 * stylesheet, so the class could be purged, renamed, or generating something
 * else entirely and the assertion would still pass while the chip overflowed.
 * Compiling `src/index.css` closes that gap — a utility that stops producing
 * `text-overflow: ellipsis` (a Tailwind upgrade, a theme edit, a broken CSS
 * build) fails the test — and it frees the assertion from the class STRING:
 * any class that yields the same declarations reads the same here, so the chip
 * can be refactored or restyled without a test edit.
 *
 * It is not a renderer. It says what CSS the element is given, not what the
 * box then measures; pixels are the visual check's job.
 */
import { compile } from 'tailwindcss';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * The application stylesheet: Tailwind, the design tokens and the plugins.
 *
 * Resolved through `path`, not `new URL(…, import.meta.url)` — Vite rewrites
 * that exact form into an asset URL (`http://localhost/src/index.css`), which
 * is not a path this can read.
 */
const APP_STYLESHEET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../index.css');
const TAILWIND_ROOT = path.dirname(require.resolve('tailwindcss/package.json'));

/** A rule's declarations, keyed by CSS property: `{ 'max-width': '100%' }`. */
export type Declarations = Record<string, string>;

async function loadStylesheet(id: string, base: string) {
  let file: string;
  if (id === 'tailwindcss') file = path.join(TAILWIND_ROOT, 'index.css');
  else if (id.startsWith('tailwindcss/')) file = path.join(TAILWIND_ROOT, id.slice('tailwindcss/'.length));
  else file = path.resolve(base, id);
  if (!file.endsWith('.css')) file += '.css';
  return { path: file, base: path.dirname(file), content: await fs.readFile(file, 'utf8') };
}

/**
 * `@plugin "…"`. Loaded with `require`, not `import()`: Vite rewrites a dynamic
 * import of a variable and warns about it, and Node ≥22.13 (this repo's engine)
 * requires ESM as happily as CJS.
 */
type LoadModule = NonNullable<Parameters<typeof compile>[1]>['loadModule'];
const loadModule: NonNullable<LoadModule> = async (id, base) => {
  const resolved = require.resolve(id, { paths: [base, path.dirname(APP_STYLESHEET)] });
  const loaded: unknown = require(resolved);
  const module = (loaded as { default?: unknown }).default ?? loaded;
  return { path: resolved, base: path.dirname(resolved), module } as Awaited<
    ReturnType<NonNullable<LoadModule>>
  >;
};

/** One compile for the whole suite — it costs ~100ms, and nothing invalidates it. */
let compiler: Promise<{ build(candidates: string[]): string }> | null = null;
function appCss() {
  compiler ??= fs
    .readFile(APP_STYLESHEET, 'utf8')
    .then((css) => compile(css, { base: path.dirname(APP_STYLESHEET), loadStylesheet, loadModule }));
  return compiler;
}

/** The body of `@layer <name> { … }`, brace-matched rather than regexed. */
function layerBody(css: string, name: string): string {
  const open = css.indexOf(`@layer ${name} {`);
  if (open < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', open); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', open) + 1, i);
  }
  return '';
}

/** Every plain `.class { … }` rule in the utilities layer, class name unescaped. */
function parseUtilities(css: string): Map<string, Declarations> {
  const rules = new Map<string, Declarations>();
  for (const [, selector, body] of layerBody(css, 'utilities').matchAll(
    /\.((?:\\.|[^{},\s])+)\s*\{([^{}]*)\}/g,
  )) {
    const className = selector.replace(/\\(.)/g, '$1');
    // Variants (`hover:…:hover`) and combinators are not a bare class: skip.
    if (/[:>~+]/.test(className)) continue;
    const declarations: Declarations = { ...rules.get(className) };
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    rules.set(className, declarations);
  }
  return rules;
}

/**
 * The declarations the element's own classes generate, merged.
 *
 * Merging is safe for asking "does this element get `text-overflow: ellipsis`"
 * and meaningless for a property two of its classes both set — read it for the
 * former only.
 */
export async function declarationsOf(element: Element): Promise<Declarations> {
  const classNames = element.className.split(/\s+/).filter(Boolean);
  const rules = parseUtilities((await appCss()).build(classNames));
  return Object.assign({}, ...classNames.map((c) => rules.get(c) ?? {})) as Declarations;
}

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

/** One style rule: its selector, its own declarations, and the at-rules around it. */
type Rule = { selector: string; declarations: string; within: string[] };

/**
 * Every style rule in the compiled stylesheet, brace-matched.
 *
 * Text becomes a selector only where it precedes a `{` and is not an at-rule
 * prelude; a `;` or `}` ends whatever was being read. So a declaration value
 * (`--spacing: .25rem`, `transition: .15s`) can never be picked up as one —
 * the dotted tokens inside theme variables and values are never selectors
 * here, which is what makes "Tailwind emitted a selector for this class" an
 * answerable question rather than "this name occurs after a dot somewhere".
 */
function* eachRule(css: string): Generator<Rule> {
  const within: string[] = [];
  let start = 0;
  let i = 0;
  while (i < css.length) {
    const character = css[i];
    if (character === '{') {
      const prelude = css.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        within.push(prelude);
        start = ++i;
        continue;
      }
      let depth = 0;
      let end = i;
      while (end < css.length) {
        if (css[end] === '{') depth++;
        else if (css[end] === '}' && --depth === 0) break;
        end++;
      }
      // Only the rule's own declarations: anything nested belongs to its own rule.
      const body = css.slice(i + 1, end);
      const nested = body.indexOf('{');
      yield {
        selector: prelude,
        declarations: nested < 0 ? body : body.slice(0, body.lastIndexOf(';', nested) + 1),
        within: [...within],
      };
      i = end + 1;
      start = i;
    } else if (character === '}') {
      within.pop();
      start = ++i;
    } else if (character === ';') {
      start = ++i;
    } else {
      i++;
    }
  }
}

/** The class names a selector targets, unescaped: `.hover\:x:hover` → `hover:x`. */
function classNamesIn(selector: string): string[] {
  return [...selector.matchAll(/\.((?:\\.|[^{},\s:>~+[.])+)/g)].map(([, name]) =>
    name.replace(/\\(.)/g, '$1'),
  );
}

/** Whether a rule sits inside `@layer utilities`. */
function inUtilities(rule: Rule): boolean {
  return rule.within.some((at) => /^@layer\s+utilities\b/.test(at));
}

/**
 * The unconditional declarations of each bare `.class` rule in the utilities
 * layer.
 *
 * Throws when the layer holds no rule at all. A missing utilities layer means
 * this parser no longer understands Tailwind's output (a version bump that
 * renames or reformats it), and degrading to "no declarations" would report
 * the chip as broken — or pass an absence assertion vacuously — while the chip
 * is fine. The helper exists to keep assertions honest, so it fails as itself.
 */
function utilityDeclarations(rules: Rule[]): Map<string, Declarations> {
  const byClass = new Map<string, Declarations>();
  let sawUtilitiesLayer = false;
  for (const rule of rules) {
    if (!inUtilities(rule)) continue;
    sawUtilitiesLayer = true;
    for (const raw of rule.selector.split(',')) {
      const selector = raw.trim();
      const [className, ...rest] = classNamesIn(selector);
      // A bare class and nothing else: `.truncate`, not `.a:hover`, `.a.b`, `.a .b`.
      if (className === undefined || rest.length) continue;
      if (selector.replace(/\\(.)/g, '$1') !== `.${className}`) continue;
      const declarations: Declarations = { ...byClass.get(className) };
      for (const declaration of rule.declarations.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
      byClass.set(className, declarations);
    }
  }
  if (!sawUtilitiesLayer) {
    throw new Error(
      `No \`@layer utilities\` rule in the compiled stylesheet: ${APP_STYLESHEET} no longer ` +
        `emits the layer this parser reads, so no element's declarations can be resolved. This ` +
        `is a fault in the test helper (most likely a Tailwind upgrade), not in the component.`,
    );
  }
  return byClass;
}

/**
 * The declarations the element's own classes generate unconditionally, merged.
 *
 * Merging is safe for asking "does this element get `text-overflow: ellipsis`"
 * and meaningless for a property two of its classes both set — read it for the
 * former only.
 *
 * A class Tailwind emitted no selector for is a purged, renamed or misspelled
 * utility, and throws rather than quietly contributing nothing. A class that is
 * only styled under a variant (`hover:text-danger`) contributes nothing here by
 * design — a rule that applies on hover is not a declaration the element has —
 * but it is known to exist, so it is not confused with a utility that has gone
 * missing. That check runs first, so an element whose classes are all unknown
 * is reported as such rather than as a missing utilities layer.
 */
export async function declarationsOf(element: Element): Promise<Declarations> {
  const classNames = element.className.split(/\s+/).filter(Boolean);
  const rules = [...eachRule((await appCss()).build(classNames))];
  const styled = new Set(rules.flatMap((rule) => classNamesIn(rule.selector)));

  const missing = classNames.filter((c) => !styled.has(c));
  if (missing.length) {
    throw new Error(
      `Tailwind emitted no CSS for ${missing.map((c) => `\`${c}\``).join(', ')} on <${element.tagName.toLowerCase()}>. ` +
        `The utility is purged, renamed or misspelled — the element is not styled the way its ` +
        `class list says it is.`,
    );
  }

  const byClass = utilityDeclarations(rules);
  return Object.assign({}, ...classNames.map((c) => byClass.get(c) ?? {})) as Declarations;
}

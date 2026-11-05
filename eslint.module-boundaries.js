// Module boundaries, as `no-restricted-imports` patterns. Used by
// `eslint.config.js`; the reason for the rule is written there, next to the
// rule's other settings. This file holds the mechanics and the backlog.
//
// A pattern sees an import's specifier as written, not the file it resolves
// to, so the same `../audit/x.js` means another module from
// `modules/mcp/a.ts` and this module's own folder from `modules/mcp/oauth/b.ts`.
// The blocks are therefore cut per module AND per folder depth inside it (a
// flat-config `*` never crosses a `/`): at depth d, d+1 `../` lead out of the
// module into `modules/`, so `^(\.\./){d+1}<other>/` names another module, and
// so does any longer way round that climbs further and comes back down
// through a `modules/` folder. One pattern per target module, so the message
// can name the entry to use.
//
// Counting `../` only measures a path in normal form, so a relative specifier
// that is not (`./../x`, `a/../x`, `a/./x`, `a//x`) is refused in the same
// files: written plainly it is either allowed or named by the patterns above.
// That includes a path that stays inside its own module (`./oauth/../x.js`
// is refused, `./x.js` passes), so "imports inside one module pass" holds for
// imports written in normal form.
//
// A package can also name its own exports: `@bevel-software/<pkg>/modules/x/y`
// reaches the same internals as `../x/y`. Each pattern therefore takes the
// package's self-reference prefix as a second way to the same module.
//
// The depths come from the tree at config load, one block per folder level
// each module actually has, so a new sub-folder is covered the day it lands.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['packages/core-backend', 'packages/core-frontend']
/** How each package names its own `src/modules/` through its `exports` map (no regex metacharacters). */
const SELF_REFERENCE = {
  'packages/core-backend': '@bevel-software/platform-core-backend/modules/',
  'packages/core-frontend': '@bevel-software/platform-core-frontend/src/modules/',
}
/** The module's public entry: its folder alone, or its `index` file. */
const INDEX = '(?:index(?:\\.(?:js|jsx|ts|tsx))?)?$'
/**
 * What a core-frontend module may reach in another module BESIDES its index:
 * a React component under `components/`, and a stylesheet. A component is
 * composed into another module's screen, not called, and a module's index
 * that re-exported its components would load every screen of the app behind
 * any hook or helper imported from it — a barrel sweep on 2026-10-22 turned
 * three import cycles into forty-seven and broke the welcome page at module
 * evaluation (a route constant read as undefined). So a frontend index carries
 * the module's hooks, services, contexts, utilities and types; its components
 * are imported by their file, as they were. Decided by Razvan on 2026-10-22.
 * The backend has no such allowance.
 */
const COMPOSED = { 'packages/core-frontend': '|components/|.*\\.css$' }
/** A relative specifier with a `.` or `..` past its leading climb, or an empty segment. */
const NOT_NORMAL = '^(?=\\.\\.?/)(?:.*//|.*/\\.(?:/|$)|\\./\\.\\.?(?:/|$)|(?:.*/)?(?!\\.\\.?(?:/|$))[^/]+/\\.\\.(?:/|$))'

/** Tests may reach into another module's internals for fixtures; the rule is about shipped code. */
export const MODULE_BOUNDARY_TEST_FILES = ['**/__tests__/**', '**/*.test.{ts,tsx}']

const subdirs = (dir) => readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())

function modulesOf(root, pkg) {
  return subdirs(join(root, pkg, 'src', 'modules')).sort()
}

/** How many folders deep the module's tree goes, its own folder being 0. */
function depthOf(dir) {
  return Math.max(0, ...subdirs(dir).map((name) => 1 + depthOf(join(dir, name))))
}

const ups = (n) => `(?:\\.\\./){${n}}`

/**
 * The flat-config blocks that enforce the rule. `paths` is merged into every
 * block's options, for packages whose files already carry a
 * `no-restricted-imports` `paths` list: a later block's options replace an
 * earlier one's, they do not add to them. `exceptions` maps repo-relative
 * files to the reason they are not yet held to the rule.
 */
export function moduleBoundaries({ root, exceptions = {}, paths = {} }) {
  const blocks = []
  for (const pkg of PACKAGES) {
    const modules = modulesOf(root, pkg)
    for (const own of modules) {
      const deepest = depthOf(join(root, pkg, 'src', 'modules', own))
      for (let depth = 0; depth <= deepest; depth++) {
        const patterns = [
          {
            regex: NOT_NORMAL,
            message:
              'Modular Domain-Driven Design: write a relative import in normal form (no `./..`, `a/..`, ' +
              '`/./` or `//`), so the module-boundary rule can see which module it reaches.',
          },
          ...modules
            .filter((other) => other !== own)
            .map((other) => ({
              regex: `^(?:${ups(depth + 1)}(?:(?:\\.\\./)+(?:[^/]+/)*modules/)?|${SELF_REFERENCE[pkg]})${other}/(?!${INDEX}${COMPOSED[pkg] ?? ''})`,
              caseSensitive: true,
              message:
                `Modular Domain-Driven Design: reach another module through its index — import from ` +
                `modules/${other}/index.ts, not its internals (export what you need from that index).`,
            })),
        ]
        blocks.push({
          name: `module-boundaries/${pkg.split('/')[1]}/${own}/depth-${depth}`,
          files: [`${pkg}/src/modules/${own}/${'*/'.repeat(depth)}*.{ts,tsx}`],
          ignores: [...MODULE_BOUNDARY_TEST_FILES, ...Object.keys(exceptions)],
          rules: {
            'no-restricted-imports': ['error', { paths: paths[pkg] ?? [], patterns }],
          },
        })
      }
    }
  }
  return blocks
}

/**
 * Files not yet held to the rule, each with what it reaches for. This is the
 * backlog: fixing an entry means exporting what the file needs from the
 * target's `index.ts` (or giving the target one), importing it from there,
 * and deleting the line here. A new file never goes on this list.
 * `module-boundaries.lint.test.ts` (core-backend) fails on an entry that no
 * longer needs to be here.
 */
export const MODULE_BOUNDARY_EXCEPTIONS = {}

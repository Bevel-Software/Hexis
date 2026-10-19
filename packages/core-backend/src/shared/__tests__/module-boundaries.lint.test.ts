import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

/**
 * Module boundaries are linted.
 *
 * The Module Map says a module under `src/modules/` is reached through its
 * `index.ts`; the repo's `eslint.config.js` enforces that with
 * `no-restricted-imports` patterns built by `eslint.module-boundaries.js`,
 * for this package and for core-frontend. CI lints only the files a change
 * touches, so this suite runs the same rule from the same config over every
 * module file, and holds the exception list to what it says it is: the
 * backlog, every entry of which still needs to be there.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = resolve(SRC, '..', '..', '..');
const BACKEND = join(REPO_ROOT, 'packages', 'core-backend', 'src');
const FRONTEND = join(REPO_ROOT, 'packages', 'core-frontend', 'src');
const RULE = 'no-restricted-imports';
const BOUNDARY = 'Modular Domain-Driven Design: reach another module through its index';

/** One instance for the suite: loading the flat config and the parser is the slow part. */
let instance: ESLint | null = null;
function eslint(): ESLint {
  instance ??= new ESLint({ cwd: REPO_ROOT, ruleFilter: ({ ruleId }) => ruleId === RULE });
  return instance;
}

/** Lint `code` as the file at `path` (relative to the repo root), with the repo's config. */
async function lintAs(path: string, code: string): Promise<string[]> {
  const [result] = await eslint().lintText(code, { filePath: join(REPO_ROOT, path) });
  return result.messages.map((m) => m.message);
}

const boundaryHits = (messages: string[]) => messages.filter((m) => m.includes(BOUNDARY));

function moduleSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') moduleSources(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

async function boundaryModule() {
  // A plain-JS module at the repo root, outside this package's types.
  const url = pathToFileURL(join(REPO_ROOT, 'eslint.module-boundaries.js')).href;
  return (await import(url)) as {
    moduleBoundaries: (o: { root: string; exceptions?: Record<string, string> }) => unknown[];
    MODULE_BOUNDARY_EXCEPTIONS: Record<string, string>;
  };
}

const BE = 'packages/core-backend/src';
const FE = 'packages/core-frontend/src';

describe('lint: module boundaries', () => {
  it("rejects a backend import of another module's internals, naming the index to use", async () => {
    const messages = await lintAs(
      `${BE}/modules/mcp/__lint_fixture__.ts`,
      "import { recordRequest } from '../audit/request-audit.js';\nexport const a = recordRequest;\n",
    );
    expect(boundaryHits(messages)).toHaveLength(1);
    expect(messages[0]).toContain('modules/audit/index.ts');
    // The first lint of the suite pays for loading the config and the parser.
  }, 60_000);

  it("allows the other module's index, with or without the extension", async () => {
    for (const spec of ['../audit/index.js', '../audit/index.ts', '../audit/index']) {
      expect(await lintAs(`${BE}/modules/mcp/__lint_fixture__.ts`, `import { a } from '${spec}';\nexport { a };\n`)).toEqual(
        [],
      );
    }
  });

  it('allows imports inside one module, at any depth', async () => {
    expect(
      await lintAs(
        `${BE}/modules/workspace/__lint_fixture__.ts`,
        "import { a } from './file-readers/doc-extract.service.js';\nexport { a };\n",
      ),
    ).toEqual([]);
    expect(
      await lintAs(`${BE}/modules/mcp/oauth/__lint_fixture__.ts`, "import { a } from '../mcp.routes.js';\nexport { a };\n"),
    ).toEqual([]);
    expect(
      await lintAs(
        `${BE}/modules/mcp/oauth/__lint_fixture__.ts`,
        "import { a } from '../../mcp/mcp.routes.js';\nexport { a };\n",
      ),
    ).toEqual([]);
  });

  it('measures the way out of the module from the importing file\'s own folder', async () => {
    // From a sub-folder, one `../` stays inside the module…
    expect(
      await lintAs(`${BE}/modules/mcp/oauth/__lint_fixture__.ts`, "import { a } from '../audit/x.js';\nexport { a };\n"),
    ).toEqual([]);
    // …and two lead into another one.
    const nested = await lintAs(
      `${BE}/modules/mcp/oauth/__lint_fixture__.ts`,
      "import { a } from '../../audit/request-audit.js';\nexport { a };\n",
    );
    expect(boundaryHits(nested)).toHaveLength(1);
    // Through `modules/` from above is the same reach.
    const viaModules = await lintAs(
      `${BE}/modules/mcp/__lint_fixture__.ts`,
      "import { a } from '../../modules/audit/request-audit.js';\nexport { a };\n",
    );
    expect(boundaryHits(viaModules)).toHaveLength(1);
  });

  it('sees type-only imports and re-exports too', async () => {
    const typeOnly = await lintAs(
      `${BE}/modules/mcp/__lint_fixture__.ts`,
      "import type { A } from '../audit/audit.contract.js';\nexport type B = A;\n",
    );
    expect(boundaryHits(typeOnly)).toHaveLength(1);
    const reExport = await lintAs(`${BE}/modules/mcp/__lint_fixture__.ts`, "export { a } from '../audit/request-audit.js';\n");
    expect(boundaryHits(reExport)).toHaveLength(1);
  });

  it('leaves shared/ and core/ alone: they are not modules', async () => {
    expect(
      await lintAs(`${BE}/modules/mcp/__lint_fixture__.ts`, "import { a } from '../../shared/logging.js';\nexport { a };\n"),
    ).toEqual([]);
    for (const dir of ['shared', 'core']) {
      expect(
        await lintAs(`${BE}/${dir}/__lint_fixture__.ts`, "import { a } from '../modules/audit/request-audit.js';\nexport { a };\n"),
      ).toEqual([]);
    }
  });

  it("lets tests reach into another module's internals for a fixture", async () => {
    expect(
      await lintAs(
        `${BE}/modules/mcp/__tests__/__lint_fixture__.test.ts`,
        "import { a } from '../../audit/request-audit.js';\nexport { a };\n",
      ),
    ).toEqual([]);
  });

  it('keeps the backend live-binding restriction in the same files', async () => {
    // A later block's options replace an earlier one's, so the boundary blocks
    // carry the live-binding `paths` along; this proves they still apply.
    const messages = await lintAs(
      `${BE}/modules/mcp/__lint_fixture__.ts`,
      "import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';\nexport const b = DEFAULT_BRANCH;\n",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('KbContext');
  });

  it('holds core-frontend modules to the same rule', async () => {
    const deep = await lintAs(
      `${FE}/modules/library/__lint_fixture__.tsx`,
      "import { FileTree } from '../workspace/components/FileTree';\nexport const a = FileTree;\n",
    );
    expect(boundaryHits(deep)).toHaveLength(1);
    expect(deep[0]).toContain('modules/workspace/index.ts');
    for (const spec of ['../workspace', '../workspace/index', './components/Thing', '../../shared/api']) {
      expect(await lintAs(`${FE}/modules/library/__lint_fixture__.tsx`, `import { a } from '${spec}';\nexport { a };\n`)).toEqual(
        [],
      );
    }
  });

  it('finds no deep import in any module file outside the exception list', async () => {
    const files = [...moduleSources(join(BACKEND, 'modules')), ...moduleSources(join(FRONTEND, 'modules'))];
    expect(files.length).toBeGreaterThan(100);
    const results = await eslint().lintFiles(files);
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === RULE && m.message.includes(BOUNDARY))
        .map((m) => `${relative(REPO_ROOT, r.filePath)}:${m.line} ${m.message}`),
    );
    expect(hits).toEqual([]);
  }, 300_000);

  it('lists only files that still need their exception, each with a reason', async () => {
    const { moduleBoundaries, MODULE_BOUNDARY_EXCEPTIONS } = await boundaryModule();
    const listed = Object.keys(MODULE_BOUNDARY_EXCEPTIONS);
    for (const [file, reason] of Object.entries(MODULE_BOUNDARY_EXCEPTIONS)) {
      expect(existsSync(join(REPO_ROOT, file)), `${file} is listed but does not exist`).toBe(true);
      expect(reason.trim(), `${file} is listed without a reason`).not.toBe('');
    }
    // The rule as written, with nobody excused: every listed file must still trip it.
    const tseslint = (await import('typescript-eslint')).default;
    const overrideConfig = [
      { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },
      ...moduleBoundaries({ root: REPO_ROOT, exceptions: {} }),
    ] as ESLint.Options['overrideConfig'];
    const bare = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: true, overrideConfig });
    const results = await bare.lintFiles(listed.map((f) => join(REPO_ROOT, f)));
    const clean = results
      .filter((r) => !r.messages.some((m) => m.message.includes(BOUNDARY)))
      .map((r) => relative(REPO_ROOT, r.filePath));
    expect(clean, 'these files no longer import another module\'s internals: delete their exception').toEqual([]);
  }, 300_000);
});

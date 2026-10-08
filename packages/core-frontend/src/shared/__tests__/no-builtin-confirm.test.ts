// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * The browser's built-in `confirm()` does not come back.
 *
 * The browser can switch it off ("prevent this page from creating additional
 * dialogs"), after which every call answers false without showing anything —
 * the branch delete stopped working that way. The rule lives in the repo's
 * `eslint.config.js`; `pnpm lint` is not part of CI, so this suite runs that
 * same rule from that same config over the package's source, and the test
 * job fails on a new use.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = resolve(SRC, '..', '..', '..');
const RULES = new Set(['no-restricted-globals', 'no-restricted-properties']);

function eslint(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => RULES.has(ruleId),
  });
}

/** Lint `code` as if it were a file in this package, with the repo's config. */
async function lintFixture(code: string): Promise<string[]> {
  const [result] = await eslint().lintText(code, {
    filePath: join(SRC, '__lint_fixture__.tsx'),
  });
  return result.messages.map((m) => `${m.ruleId}:${m.line}`);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('lint: no built-in confirm', () => {
  it('rejects the global confirm() and window.confirm()', async () => {
    expect(await lintFixture("export const a = confirm('Delete?');\n")).toEqual([
      'no-restricted-globals:1',
    ]);
    expect(await lintFixture("export const b = window.confirm('Delete?');\n")).toEqual([
      'no-restricted-properties:1',
    ]);
    expect(await lintFixture("export const c = globalThis.confirm('Delete?');\n")).toEqual([
      'no-restricted-properties:1',
    ]);
  });

  it("allows a local function called confirm (useConfirm()'s result, the file tree's)", async () => {
    const code = [
      "import { useConfirm } from './shared/components';",
      'export function useThing() {',
      '  const confirm = useConfirm();',
      "  return () => confirm({ title: 'Delete', message: 'Delete?' });",
      '}',
      '',
    ].join('\n');
    expect(await lintFixture(code)).toEqual([]);
  });

  it('finds no built-in confirm anywhere in core-frontend', async () => {
    // Only files that mention the word can break the rule; lint just those so
    // the suite stays quick, with the real config.
    const candidates = sourceFiles(SRC).filter((f) => /\bconfirm\b/.test(readFileSync(f, 'utf8')));
    expect(candidates.length).toBeGreaterThan(0);
    const results = await eslint().lintFiles(candidates);
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId && RULES.has(m.ruleId))
        .map((m) => `${relative(SRC, r.filePath)}:${m.line} ${m.message}`),
    );
    expect(hits).toEqual([]);
  }, 120_000);
});

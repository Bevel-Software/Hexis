import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_NODE_MAJORS } from '../preflight.js';

/**
 * ONE list of supported Node majors, said in four places.
 *
 * `SUPPORTED_NODE_MAJORS` is what the preflight refuses on, `engines` is what
 * npm warns on, and the CI matrix is the only one of the three that is
 * EVIDENCE rather than a claim. They drift silently — nothing breaks when a
 * major is added to one and not the others, until somebody's laptop finds out
 * — so this pins them to each other.
 *
 * The list itself is not a preference: it is the set of Node ABIs
 * `isolated-vm` publishes a prebuilt binary for (`prebuilds/…/isolated-vm.abi
 * <NODE_MODULE_VERSION>.*.node` in its tarball — abi127 = Node 22,
 * abi137 = Node 24 at 6.1.2). Changing it means re-reading that folder.
 */

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(pkgDir, '..', '..');

function engines(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { engines?: { node?: string } };
  return pkg.engines?.node ?? '';
}

/**
 * The range that says EXACTLY these majors — one `>=M <M+1` clause each. Not
 * `>=22 <25`: that would promise Node 23, which has no binary and would put a
 * C++ compile on the user's machine.
 */
function expectedRange(majors: readonly number[], floors: Record<number, string> = {}): string {
  return majors.map((m) => `>=${floors[m] ?? m} <${m + 1}`).join(' || ');
}

describe('the supported Node majors', () => {
  it('are the ones isolated-vm ships prebuilt binaries for', () => {
    expect([...SUPPORTED_NODE_MAJORS]).toEqual([22, 24]);
  });

  it('are what `engines` promises, in both published packages', () => {
    // The 22.13 floor predates this range and stays: `pdfjs-dist` needs it,
    // and the repo's `.nvmrc` is that line.
    const range = expectedRange(SUPPORTED_NODE_MAJORS, { 22: '22.13' });
    expect(engines(join(pkgDir, 'package.json'))).toBe(range);
    expect(engines(join(repoRoot, 'packages', 'mcp-core', 'package.json'))).toBe(range);
  });
});

describe('the CI matrix', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf-8');

  it('runs the hexis-mcp suite on each supported major, and only those', () => {
    const matrix = /^\s*node: \[([^\]]*)\]\s*$/m.exec(workflow);
    expect(matrix, 'no `node: [...]` matrix in .github/workflows/test.yml').not.toBeNull();
    const majors = matrix![1]!.split(',').map((v) => Number(v.trim()));
    expect(majors).toEqual([...SUPPORTED_NODE_MAJORS]);
  });

  it('runs this package as that matrix job', () => {
    const job = workflow.slice(workflow.indexOf('\n  hexis-mcp:'));
    expect(job, 'no `hexis-mcp` job in .github/workflows/test.yml').not.toBe('');
    expect(job).toContain('node-version: ${{ matrix.node }}');
    expect(job).toContain('--filter @bevel-software/hexis-mcp');
    expect(job).toContain('run test');
  });
});

/**
 * The FOURTH place the list is said, and the only one a user reads before
 * they hit the refusal. A doc naming a version the preflight rejects sends
 * someone to install it; a doc missing a version they could have used sends
 * them to fix a machine that was fine. Both drift silently, so they are
 * pinned here alongside `engines` and the CI matrix.
 */
describe('the documentation', () => {
  /** `Node 22 or 24` — the phrase the preflight sentence and the UI both use. */
  const phrase = `Node ${SUPPORTED_NODE_MAJORS.slice(0, -1).join(', ')} or ${
    SUPPORTED_NODE_MAJORS[SUPPORTED_NODE_MAJORS.length - 1]
  }`;

  const docs = {
    "the package's own README, which is the npm page": join(pkgDir, 'README.md'),
    "the repo's README": join(repoRoot, 'README.md'),
    'the troubleshooting guide': join(repoRoot, 'docs', 'troubleshooting.md'),
  };

  for (const [what, path] of Object.entries(docs)) {
    it(`names the supported versions in ${what}`, () => {
      expect(readFileSync(path, 'utf-8')).toContain(phrase);
    });

    /**
     * The other half of the same reader's problem: a GUI-launched client
     * never read the shell profile that put `npx` on PATH, so the fix is an
     * absolute path rather than a Node version. A doc that names the
     * versions and not this one leaves the Cursor case unanswered.
     */
    it(`tells a GUI-launched client how to find npx, in ${what}`, () => {
      const text = readFileSync(path, 'utf-8');
      expect(text).toContain('which npx');
      expect(text).toMatch(/PATH/);
    });
  }
});

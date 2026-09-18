import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_NODE,
  SUPPORTED_NODE_MAJORS,
  loadNativeSandbox,
  nodeMajor,
  preflight,
} from '../preflight.js';

/** The way out the sentences name, derived exactly as they derive it. */
const howToSelect = `nvm install ${SUPPORTED_NODE_MAJORS[0]}`;

/**
 * The runtime preflight: one sentence instead of a dlopen stack trace.
 *
 * The version half is SIMULATED — a test cannot be Node 26 — so `preflight`
 * takes the version and the load probe as injectable arguments and this suite
 * drives them. What is NOT simulated is the probe's real resolution walk,
 * which is exercised against this installation below: under pnpm's isolated
 * `node_modules`, `isolated-vm` is code-mode's peer dependency and not
 * resolvable from here directly, so a probe that quietly answered
 * "unresolved" would disable the whole check without failing anything.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('nodeMajor', () => {
  it('reads the major from either spelling, and refuses nonsense', () => {
    expect(nodeMajor('22.13.1')).toBe(22);
    expect(nodeMajor('v24.21.0')).toBe(24);
    expect(nodeMajor('26.0.0-nightly')).toBe(26);
    expect(nodeMajor('unreleased')).toBeNull();
  });
});

describe('preflight on an unsupported Node', () => {
  it('returns ONE sentence naming the supported versions and how to select one', () => {
    const sentence = preflight({ nodeVersion: '26.1.0', probeNativeSandbox: () => 'loaded' });
    expect(sentence).not.toBeNull();
    // ONE sentence: it ends with a full stop and contains no other one that
    // TERMINATES anything — a `. ` mid-string would be a second sentence.
    // (The dots inside `26.1.0` are not followed by a space.)
    expect(sentence).not.toContain('\n');
    expect(sentence!.endsWith('.')).toBe(true);
    expect(sentence).not.toMatch(/\.\s/);
    // It names: the supported versions, the one in use, and the way out.
    for (const major of SUPPORTED_NODE_MAJORS) expect(sentence).toContain(String(major));
    expect(sentence).toContain('26.1.0');
    expect(sentence).toContain(howToSelect);
    expect(sentence).toContain('command');
    // And it reads as a sentence, not as a thrown error: a single line (above)
    // with none of the wrapper a stack trace opens with.
    expect(sentence).not.toMatch(/\bError\b/);
  });

  it('does not even try to load the native module — that import is what crashes', () => {
    let probed = false;
    preflight({
      nodeVersion: '26.1.0',
      probeNativeSandbox: () => {
        probed = true;
        return 'loaded';
      },
    });
    expect(probed).toBe(false);
  });

  it('passes every supported version, from its floor up', () => {
    for (const node of SUPPORTED_NODE) {
      for (const version of [`${node.floor}.0`, `${node.major}.99.0`]) {
        expect(preflight({ nodeVersion: version, probeNativeSandbox: () => 'loaded' })).toBeNull();
      }
    }
  });

  it('refuses the majors between them, which ship no prebuilt binary', () => {
    expect(preflight({ nodeVersion: '23.11.0', probeNativeSandbox: () => 'loaded' })).not.toBeNull();
  });

  /**
   * The floor is not decoration: `engines` says `>=22.13`, so 22.5 is a
   * version this package does not publish for. Refusing it here is what makes
   * the preflight agree with the range npm enforces — a major-only check would
   * start on it and leave the reader to find out some other way. String order
   * puts `22.5` after `22.13`, which is the comparison this guards.
   */
  it('refuses a supported major BELOW its floor', () => {
    const sentence = preflight({ nodeVersion: '22.5.0', probeNativeSandbox: () => 'loaded' });
    expect(sentence).not.toBeNull();
    expect(sentence).toContain('22.5.0');
    expect(sentence).toContain('22.13+');
    expect(preflight({ nodeVersion: '22.12.9', probeNativeSandbox: () => 'loaded' })).not.toBeNull();
    expect(preflight({ nodeVersion: '22.13.0', probeNativeSandbox: () => 'loaded' })).toBeNull();
  });
});

describe('preflight when the native module will not load', () => {
  it('turns the dlopen failure into one sentence, keeping none of its stack', () => {
    const sentence = preflight({
      nodeVersion: '22.13.1',
      probeNativeSandbox: () => {
        throw new Error(
          'Error: /x/isolated-vm.node: undefined symbol: _ZN2v88internal1X\n    at Module._load (node:internal/modules)',
        );
      },
    });
    expect(sentence).not.toBeNull();
    expect(sentence).not.toContain('\n');
    expect(sentence).not.toMatch(/\.\s/);
    expect(sentence).not.toContain('at Module._load');
    expect(sentence).toContain('isolated-vm');
    expect(sentence).toContain(howToSelect);
  });

  it('says nothing when the module is merely absent — an embedder is not a broken install', () => {
    expect(preflight({ nodeVersion: '22.13.1', probeNativeSandbox: () => 'unresolved' })).toBeNull();
  });

  /**
   * The CLI is not that embedder: its next statement imports `server.js`, and
   * through it code-mode's module-level `isolated-vm` import, so `unresolved`
   * there is an ERR_MODULE_NOT_FOUND stack trace one line away — the exact
   * thing this preflight exists to replace with a sentence.
   */
  it('refuses an absent module when the caller is about to import code-mode', () => {
    const sentence = preflight({
      nodeVersion: '22.13.1',
      probeNativeSandbox: () => 'unresolved',
      requireNativeSandbox: true,
    });
    expect(sentence).not.toBeNull();
    expect(sentence).not.toContain('\n');
    expect(sentence).not.toMatch(/\.\s/);
    expect(sentence).toContain('isolated-vm');
    expect(sentence).toContain('22.13+');
    expect(sentence).not.toMatch(/\bError\b/);
  });
});

describe('the real probe, against this installation', () => {
  it('finds and loads isolated-vm — a probe that could not would silently disable the check', () => {
    expect(loadNativeSandbox()).toBe('loaded');
  });

  it('passes on the Node this suite is running on', () => {
    expect(preflight()).toBeNull();
  });
});

describe('the CLI runs the preflight BEFORE anything native is imported', () => {
  it('imports server.js dynamically, since a static import is evaluated first', () => {
    const cli = readFileSync(join(pkgDir, 'src', 'cli.ts'), 'utf-8');
    // @utcp/code-mode imports the isolated-vm addon at module level, so a
    // static `import … from './server.js'` at the top of cli.ts is evaluated —
    // and dies — before `main()` gets to say anything. This is the regression
    // that would put the stack trace back, and nothing else in the suite
    // could catch it: on a supported Node both forms work identically.
    expect(cli).not.toMatch(/^import .*from '\.\/server\.js';$/m);
    expect(cli).toContain("await import('./server.js')");
    // And the preflight has to come first in the file, not merely be present.
    expect(cli.indexOf('preflight(')).toBeLessThan(cli.indexOf("await import('./server.js')"));
    // And it asks for the strict reading: see the `requireNativeSandbox` case
    // above — for the CLI an unresolved module is a crash, not an embedder's
    // slimmer install.
    expect(cli).toContain('preflight({ requireNativeSandbox: true })');
  });
});

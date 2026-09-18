import { createRequire } from 'node:module';

/**
 * The runtime check that runs BEFORE anything native is imported.
 *
 * The sandbox this server executes `call_tool_chain` in is `isolated-vm`, a
 * native addon reached through `@utcp/code-mode`. A native addon binds to one
 * V8 ABI, so it only loads on a Node major it was built for — and building it
 * on the user's machine (the `node-gyp rebuild` half of its install script) is
 * a C++ compile most people running `npx` neither expect nor have a toolchain
 * for. So the supported range is not a preference: it is exactly the majors
 * `isolated-vm` ships a prebuilt binary for.
 *
 * `@utcp/code-mode` imports `isolated-vm` at MODULE level, so on a wrong Node
 * the failure lands while `server.ts` is being imported — before a single line
 * of ours runs, as a `ERR_DLOPEN_FAILED` stack trace under whatever the MCP
 * client shows for "the server died". This module exists so the check happens
 * first and says one sentence instead. That is also why `cli.ts` imports
 * `server.js` DYNAMICALLY: a static import would be evaluated (and would
 * crash) before `preflight()` could run.
 */

/**
 * The Node versions `isolated-vm@6.1.2` publishes prebuilt binaries for, each
 * with the lowest version of that major this repo supports.
 *
 * The MAJORS are read off the published tarball's `prebuilds/` folder, which
 * carries exactly two ABIs — `abi127` (Node 22) and `abi137` (Node 24) — for
 * linux-x64, linux-arm64 (glibc and musl), darwin-arm64 and win32-x64. Node 23
 * has no binary there, which is why this is a list rather than a range:
 * `>=22 <25` would promise a version that compiles instead of downloading.
 *
 * The FLOOR inside a major is a second, independent constraint: 22.13 is what
 * the repo's `.nvmrc` pins and what `pdfjs-dist` requires, and it is what both
 * published packages' `engines` says. A runtime that satisfies the major but
 * not the floor is outside the range we publish, so it gets the same sentence
 * rather than starting on a version nobody tests.
 *
 * Bumping `isolated-vm` means re-reading that folder and editing this list,
 * the `engines` fields and the CI matrix together — `supported-node.test.ts`
 * fails while they disagree.
 */
export interface SupportedNode {
  readonly major: number;
  /** The lowest supported version of this major, as `engines` spells it: `22.13`, `24`. */
  readonly floor: string;
}

export const SUPPORTED_NODE: readonly SupportedNode[] = [
  { major: 22, floor: '22.13' },
  { major: 24, floor: '24' },
];

/** Just the majors — the ABI list, without the floors. */
export const SUPPORTED_NODE_MAJORS: readonly number[] = SUPPORTED_NODE.map((n) => n.major);

/**
 * `>=22.13 <23 || >=24 <25` — the `engines` range that says EXACTLY these
 * versions. One `>=floor <major+1` clause each, never a single span: a span
 * would promise the majors in between, which have no prebuilt binary.
 */
export function enginesRange(nodes: readonly SupportedNode[] = SUPPORTED_NODE): string {
  return nodes.map((n) => `>=${n.floor} <${n.major + 1}`).join(' || ');
}

/** `22.13+ or 24`, and `22.13+, 24 or 26` when a third arrives. */
export function supportedNodePhrase(nodes: readonly SupportedNode[] = SUPPORTED_NODE): string {
  const said = nodes.map((n) => (n.floor === String(n.major) ? String(n.major) : `${n.floor}+`));
  if (said.length === 0) return 'no version';
  if (said.length === 1) return said[0]!;
  return `${said.slice(0, -1).join(', ')} or ${said[said.length - 1]!}`;
}

/** The major of a `process.versions.node` string, or null when unreadable. */
export function nodeMajor(version: string): number | null {
  const major = /^v?(\d+)\./.exec(version.trim())?.[1];
  if (major === undefined) return null;
  const parsed = Number(major);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A version as one comparable number, so `22.5.0 < 22.13` is arithmetic
 * rather than string order (which puts `22.5` after `22.13`). Missing
 * components count as zero, which is what makes the floor `22.13` comparable
 * to a full `22.13.1`.
 */
function versionOrder(version: string): number | null {
  const parts = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (parts === null) return null;
  return Number(parts[1]) * 1_000_000 + Number(parts[2] ?? 0) * 1_000 + Number(parts[3] ?? 0);
}

/**
 * Does this version reach its major's floor? An unreadable version is given
 * the benefit of the doubt — the load probe is the real test, and it answers
 * for whatever runtime this actually is.
 */
function reachesFloor(version: string, node: SupportedNode): boolean {
  const here = versionOrder(version);
  const floor = versionOrder(node.floor);
  return here === null || floor === null || here >= floor;
}

/**
 * One line, whatever the underlying error felt like saying. A dlopen failure
 * is several lines of paths and symbol names; the sentence has to stay a
 * sentence, and the detail is the part a reader can act on least.
 */
function firstLine(text: string): string {
  return text.split('\n')[0]!.trim();
}

/**
 * How to get onto a supported version, in one clause.
 *
 * `nvm install` rather than `nvm use`: the range has a floor inside a major,
 * so a reader refused on 22.5 whose only installed 22 IS 22.5 would be sent
 * in a circle by `nvm use 22`. The MCP client's `command` is named because a
 * GUI-launched client (Cursor, Claude Desktop) does not run the user's shell
 * and so cannot be fixed by switching versions in a terminal — it has to be
 * pointed at that version's `npx`, which is what the configuration runs.
 */
function howToSelect(): string {
  return (
    `\`nvm install ${SUPPORTED_NODE_MAJORS[0]}\` or by pointing your MCP client's "command" ` +
    "at that version's `npx`"
  );
}

/** ONE sentence: which versions work, which one this is, and how to switch. */
export function unsupportedNodeSentence(version: string): string {
  return (
    `hexis-mcp runs on Node ${supportedNodePhrase()} (the versions its native sandbox ships a prebuilt binary for) ` +
    `but this is Node ${version.replace(/^v/, '')} — select a supported version with ${howToSelect()}.`
  );
}

/** ONE sentence for a native module that resolved but would not load. */
export function nativeSandboxSentence(version: string, reason: string): string {
  return (
    `hexis-mcp could not load its native sandbox on Node ${version.replace(/^v/, '')} ` +
    `(isolated-vm: ${firstLine(reason)}) — run it on Node ${supportedNodePhrase()}, selecting one with ${howToSelect()}.`
  );
}

/**
 * ONE sentence for a native module that is not installed at all.
 *
 * Only the CLI asks for this (see `requireNativeSandbox`): it is about to
 * import `@utcp/code-mode`, whose module-level `import 'isolated-vm'` would
 * throw `ERR_MODULE_NOT_FOUND` as a stack trace with nothing in it for the
 * reader. An install that skipped the binary is what this looks like.
 */
export function missingNativeSandboxSentence(): string {
  return (
    'hexis-mcp could not find its native sandbox (isolated-vm, which installs alongside @utcp/code-mode) — ' +
    `reinstall the package on Node ${supportedNodePhrase()}, where its prebuilt binary downloads instead of being compiled.`
  );
}

/**
 * What loading the native sandbox did. `unresolved` is NOT a failure on its
 * own: an embedding host may have installed this package without the
 * code-mode extras, and refusing to start over a module we cannot even find
 * would be inventing a problem. The CLI, which is about to import code-mode,
 * asks for it to be one (`requireNativeSandbox`). A module that resolves and
 * then throws is the ABI mismatch this preflight is for, always.
 */
export type NativeSandboxProbe = () => 'loaded' | 'unresolved';

/**
 * Load `isolated-vm` the way `@utcp/code-mode` will.
 *
 * Under pnpm's isolated `node_modules` it is NOT resolvable from this package
 * — it is code-mode's peer dependency, not ours — so the resolution walks
 * from code-mode's own entry point. Both are tried, because a hoisted install
 * (npm, yarn, `--shamefully-hoist`) puts it in reach directly.
 */
export const loadNativeSandbox: NativeSandboxProbe = () => {
  const here = createRequire(import.meta.url);
  const requires = [here];
  try {
    requires.push(createRequire(here.resolve('@utcp/code-mode')));
  } catch {
    // code-mode itself is not installed; the direct attempt still stands.
  }
  for (const req of requires) {
    let resolved: string;
    try {
      resolved = req.resolve('isolated-vm');
    } catch {
      continue; // not reachable from here — try the next root
    }
    // Resolution SUCCEEDED, so anything thrown from here is a load failure:
    // the wrong-ABI binary, or a missing one. Deliberately not caught — the
    // caller turns it into the sentence.
    req(resolved);
    return 'loaded';
  }
  return 'unresolved';
};

export interface PreflightOptions {
  /** Defaults to `process.versions.node`; injected so a test can be Node 26. */
  nodeVersion?: string;
  /** Defaults to {@link loadNativeSandbox}; injected so a test can fail it. */
  probeNativeSandbox?: NativeSandboxProbe;
  /**
   * Is a sandbox that cannot even be RESOLVED a refusal? The CLI says yes —
   * its very next statement imports `server.js`, and through it code-mode's
   * module-level `isolated-vm` import, so an unresolved module is a crash
   * one line away rather than a hypothetical. An embedding host that never
   * runs a code-mode chain is fine without it, so the default is no.
   */
  requireNativeSandbox?: boolean;
}

/**
 * The one sentence to print before exiting non-zero, or `null` to carry on.
 *
 * Synchronous on purpose: it must complete before `server.js` is imported,
 * and `require` of a native addon is synchronous anyway.
 */
export function preflight(options: PreflightOptions = {}): string | null {
  const version = options.nodeVersion ?? process.versions.node;
  const probe = options.probeNativeSandbox ?? loadNativeSandbox;

  const major = nodeMajor(version);
  // An unreadable version is not a reason to refuse: the load probe below is
  // the real test, and it answers for whatever this runtime actually is.
  if (major !== null) {
    const supported = SUPPORTED_NODE.find((n) => n.major === major);
    // Both halves of the range, one sentence: the wrong major (no binary at
    // all) and the right major below its floor (outside what `engines`
    // publishes, and what nobody tests).
    if (supported === undefined || !reachesFloor(version, supported)) {
      return unsupportedNodeSentence(version);
    }
  }
  let loaded: 'loaded' | 'unresolved';
  try {
    loaded = probe();
  } catch (err) {
    return nativeSandboxSentence(version, err instanceof Error ? err.message : String(err));
  }
  if (loaded === 'unresolved' && options.requireNativeSandbox === true) {
    return missingNativeSandboxSentence();
  }
  return null;
}

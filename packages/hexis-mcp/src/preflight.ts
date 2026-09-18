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
 * The Node majors `isolated-vm@6.1.2` publishes prebuilt binaries for.
 *
 * Read off the published tarball's `prebuilds/` folder, which carries exactly
 * two ABIs — `abi127` (Node 22) and `abi137` (Node 24) — for linux-x64,
 * linux-arm64 (glibc and musl), darwin-arm64 and win32-x64. Node 23 has no
 * binary there, which is why this is a list of majors rather than a range:
 * `>=22 <25` would promise a version that compiles instead of downloading.
 *
 * Bumping `isolated-vm` means re-reading that folder and editing this line,
 * the `engines` field, and the CI matrix together.
 */
export const SUPPORTED_NODE_MAJORS: readonly number[] = [22, 24];

/** `22 or 24`, and `22, 24 or 26` when a third arrives. */
function supportedMajorsPhrase(majors: readonly number[] = SUPPORTED_NODE_MAJORS): string {
  if (majors.length === 0) return 'no version';
  if (majors.length === 1) return String(majors[0]);
  return `${majors.slice(0, -1).join(', ')} or ${majors[majors.length - 1]}`;
}

/** The major of a `process.versions.node` string, or null when unreadable. */
export function nodeMajor(version: string): number | null {
  const major = /^v?(\d+)\./.exec(version.trim())?.[1];
  if (major === undefined) return null;
  const parsed = Number(major);
  return Number.isFinite(parsed) ? parsed : null;
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
 * ONE sentence: which versions work, which one this is, and how to switch.
 *
 * `nvm use` is named because it is what the machines that hit this have; the
 * MCP client's `command` is named because a GUI-launched client (Cursor,
 * Claude Desktop) does not run the user's shell and so cannot be fixed by
 * switching versions in a terminal — it has to be pointed at the binary.
 */
export function unsupportedNodeSentence(version: string): string {
  const majors = supportedMajorsPhrase();
  return (
    `hexis-mcp runs on Node ${majors} (the versions its native sandbox ships a prebuilt binary for) ` +
    `but this is Node ${version.replace(/^v/, '')} — select a supported version with ` +
    `\`nvm use ${SUPPORTED_NODE_MAJORS[0]}\` or point your MCP client's "command" at that version's node binary.`
  );
}

/** ONE sentence for a native module that resolved but would not load. */
export function nativeSandboxSentence(version: string, reason: string): string {
  const majors = supportedMajorsPhrase();
  return (
    `hexis-mcp could not load its native sandbox on Node ${version.replace(/^v/, '')} ` +
    `(isolated-vm: ${firstLine(reason)}) — run it on Node ${majors}, selecting one with ` +
    `\`nvm use ${SUPPORTED_NODE_MAJORS[0]}\` or by pointing your MCP client's "command" at that version's node binary.`
  );
}

/**
 * What loading the native sandbox did. `unresolved` is NOT a failure: an
 * embedding host may have installed this package without the code-mode
 * extras, and refusing to start over a module we cannot even find would be
 * inventing a problem. Only a module that resolves and then throws is the
 * ABI mismatch this preflight is for.
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
  if (major !== null && !SUPPORTED_NODE_MAJORS.includes(major)) {
    return unsupportedNodeSentence(version);
  }
  try {
    probe();
  } catch (err) {
    return nativeSandboxSentence(version, err instanceof Error ? err.message : String(err));
  }
  return null;
}

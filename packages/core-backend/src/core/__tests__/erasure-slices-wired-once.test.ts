import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Account erasure runs two kinds of slice: core's own (the vault's managed
 * sign-ins, revoked with their provider before the user row and its rows
 * cascade away) and the distribution's, from `CorePorts.erasureParticipants`.
 * The port's array is held by reference so a root may fill it AFTER
 * construction, and core never writes into it: a root that builds a graph
 * over the same array more than once (a tenant brought back after eviction)
 * would otherwise accumulate every past graph's vault slice, each pointing
 * at that graph's closed pool.
 *
 * Read off the source, as `set-aside-root-is-one-place.test.ts` reads it:
 * the composition root cannot be built in a unit test (it wants a database,
 * a git host and a disk), and the invariant is about the TEXT — the service
 * is constructed once, the port's array is passed as it is, core's slice
 * travels beside it, and nothing pushes into or copies the port's array.
 * `AccountErasureService`'s own suite pins what that argument order means.
 */

const compositionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../create-core-services.ts');

describe('the erasure slices the composition root wires', () => {
  it('passes the port’s array untouched and the vault’s slice beside it, once', async () => {
    const source = await fs.readFile(compositionRoot, 'utf8');

    const constructions = source.match(/new AccountErasureService\(/g) ?? [];
    expect(constructions).toHaveLength(1);

    // The one construction: the port's array as the root received it (or an
    // empty one of core's own), then core's slices with the vault's first.
    const call = source.slice(source.indexOf('new AccountErasureService('));
    const args = call.slice(0, call.indexOf(');') + 2);
    expect(args).toMatch(/ports\.erasureParticipants \?\? \[\]/);
    expect(args).toMatch(/\[\s*managedSignInErasure\(secretsVaultService\),?\s*\]/);
    expect(args.indexOf('ports.erasureParticipants')).toBeLessThan(args.indexOf('managedSignInErasure'));

    // Never written into, never copied: the array a root fills after
    // construction is the array erasure reads, with nothing of core's in it.
    expect(source).not.toMatch(/erasureParticipants\s*\.\s*(push|unshift|splice)\(/);
    expect(source).not.toMatch(/\.\.\.\s*\(?\s*ports\.erasureParticipants/);
  });
});

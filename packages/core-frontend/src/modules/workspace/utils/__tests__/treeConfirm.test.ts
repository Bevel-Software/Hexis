import { describe, it, expect } from 'vitest';
import { moveWarnings, platformFileDragRefusal, platformFileMoveRefusal } from '../treeConfirm';

const KB = 'knowledge-base';

/**
 * What the tree refuses before it asks, and what it no longer warns about.
 *
 * The refusal is the server's sentence, decided by the shared predicate, so
 * the sidebar cannot drift from the endpoint it would have called.
 */
describe('platformFileMoveRefusal', () => {
  it('refuses the four platform files where the platform reads them', () => {
    expect(platformFileMoveRefusal(`${KB}/access.md`, KB))
      .toBe('access.md is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/Sales/access.md`, KB))
      .toBe('access.md is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/Sales/.bevelignore`, KB))
      .toBe('.bevelignore is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/roles.yaml`, KB))
      .toBe('roles.yaml is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/AGENTS.md`, KB))
      .toBe('AGENTS.md is a platform file and stays in its folder.');
  });

  it('leaves content alone, including a nested roles.yaml or AGENTS.md the platform never reads', () => {
    expect(platformFileMoveRefusal(`${KB}/Sales/deal.md`, KB)).toBeNull();
    expect(platformFileMoveRefusal(`${KB}/Sales/roles.yaml`, KB)).toBeNull();
    expect(platformFileMoveRefusal(`${KB}/Sales/AGENTS.md`, KB)).toBeNull();
    // Exact spelling, as the platform reads it.
    expect(platformFileMoveRefusal(`${KB}/Sales/Access.md`, KB)).toBeNull();
  });

  it('refuses nothing outside the KB clone, or before the clone folder is known', () => {
    // No repo-relative form to judge — the server is the gate and says the
    // same sentence, so the tree stays quiet rather than guessing.
    expect(platformFileMoveRefusal(`${KB}/access.md`, null)).toBeNull();
    expect(platformFileMoveRefusal('scratch/access.md', KB)).toBeNull();
  });
});

describe('platformFileDragRefusal', () => {
  const sentence = (n: string) => `${n} is a platform file and stays in its folder.`;

  it('is the rename refusal for anyone who is not an admin', () => {
    for (const p of [`${KB}/access.md`, `${KB}/Sales/access.md`, `${KB}/Sales/.bevelignore`]) {
      expect(platformFileDragRefusal(p, KB, false)).toBe(platformFileMoveRefusal(p, KB));
    }
  });

  it('lets an admin drag a MISPLACED copy — the drag that puts one back', () => {
    expect(platformFileDragRefusal(`${KB}/Sales/access.md`, KB, true)).toBeNull();
    expect(platformFileDragRefusal(`${KB}/Sales/.bevelignore`, KB, true)).toBeNull();
  });

  it("never lets go of the root's own copy, which is the one a restore puts back", () => {
    expect(platformFileDragRefusal(`${KB}/access.md`, KB, true)).toBe(sentence('access.md'));
    expect(platformFileDragRefusal(`${KB}/roles.yaml`, KB, true)).toBe(sentence('roles.yaml'));
    expect(platformFileDragRefusal(`${KB}/.bevelignore`, KB, true)).toBe(sentence('.bevelignore'));
    expect(platformFileDragRefusal(`${KB}/AGENTS.md`, KB, true)).toBe(sentence('AGENTS.md'));
  });

  it('leaves ordinary content alone for either of them', () => {
    for (const admin of [true, false]) {
      expect(platformFileDragRefusal(`${KB}/Sales/deal.md`, KB, admin)).toBeNull();
      expect(platformFileDragRefusal(`${KB}/access.md`, null, admin)).toBeNull();
    }
  });
});

describe('moveWarnings', () => {
  it('no longer warns about a platform file — the move never reaches the dialog', () => {
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Legal/access.md`,
        targetDir: `${KB}/KnowledgeBase/Sales`,
        destinationLabel: 'Sales',
        kbDirName: KB,
        canWrite: null,
      }),
    ).toEqual([]);
  });

  it('still says what it alone knows: a denied destination and a change of root', () => {
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Legal/contract.pdf`,
        targetDir: `${KB}/Data`,
        destinationLabel: 'Data',
        kbDirName: KB,
        canWrite: false,
      }),
    ).toEqual([
      "You can't write to Data — the move will be refused.",
      'This moves it out of KnowledgeBase/ into Data/ — the two roots are handled differently.',
    ]);
  });

  it('does not predict a refusal for the one move a denied destination still takes', () => {
    // The admin's restore: a misplaced access.md into a folder that has none.
    // "The move will be refused" would be the wrong prediction — this is the
    // move the destination's rules are bypassed for.
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Misplaced/access.md`,
        targetDir: `${KB}/KnowledgeBase/Legal`,
        destinationLabel: 'Legal',
        kbDirName: KB,
        canWrite: false,
      }),
    ).toEqual([
      "You can't write to Legal, but putting access.md back where the platform reads it is allowed for an Admin.",
    ]);
  });
});

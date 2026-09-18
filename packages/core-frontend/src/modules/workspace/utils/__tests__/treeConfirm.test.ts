import { describe, it, expect } from 'vitest';
import { moveWarnings, platformFileMoveRefusal } from '../treeConfirm';

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
});

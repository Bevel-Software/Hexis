import { describe, it, expect } from 'vitest';
import { moveIntoItselfRefusal, moveIntoItselfSentence } from '@bevel-software/platform-shared';

describe('moveIntoItselfRefusal', () => {
  it('refuses a child and a deeper destination with one sentence', () => {
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Team')).toBe(
      'Nothing can be moved into itself: "kb/Team/Team" is inside "kb/Team". Choose a destination outside "kb/Team".',
    );
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Twin/Team')).not.toBeNull();
  });

  it('reads other spellings of a path inside the source as inside it', () => {
    expect(moveIntoItselfRefusal('kb/Team/', 'kb//Team/./Twin/')).toContain('"kb/Team/Twin" is inside "kb/Team"');
  });

  it('leaves another case of the name to the filesystem: as strings it is another folder', () => {
    // `team` is `Team` on a volume that folds case and a sibling on one that
    // does not; the server asks its disk (destinationInsideSource).
    expect(moveIntoItselfRefusal('kb/Team', 'kb/team/Twin')).toBeNull();
  });

  it('never resolves `..`, so a climb out of the source is not read as inside it', () => {
    expect(moveIntoItselfRefusal('kb/Team', '../kb/Team/Twin')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team', '../../kb/Team/Twin')).toBeNull();
  });

  it('lets through a sibling with the same prefix, the parent, and the source itself', () => {
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team2/Team')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team/Twin', 'kb/Team')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/')).toBeNull();
  });
});

describe('moveIntoItselfSentence', () => {
  it('names both paths as given, without their trailing slashes', () => {
    expect(moveIntoItselfSentence('kb/Team/', 'kb/team/Twin/')).toBe(
      'Nothing can be moved into itself: "kb/team/Twin" is inside "kb/Team". Choose a destination outside "kb/Team".',
    );
  });
});

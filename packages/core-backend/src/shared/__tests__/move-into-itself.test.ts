import { describe, it, expect } from 'vitest';
import { moveIntoItselfRefusal } from '@bevel-software/platform-shared';

describe('moveIntoItselfRefusal', () => {
  it('refuses a child and a deeper destination with one sentence', () => {
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Team')).toBe(
      'Nothing can be moved into itself: "kb/Team/Team" is inside "kb/Team". Choose a destination outside "kb/Team".',
    );
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Twin/Team')).not.toBeNull();
  });

  it('reads other spellings of a path inside the source as inside it, another case included', () => {
    expect(moveIntoItselfRefusal('kb/Team/', 'kb//Team/./Twin/')).toContain('"kb/Team/Twin" is inside "kb/Team"');
    // One folder on a case-insensitive filesystem, and one name to the repository.
    expect(moveIntoItselfRefusal('kb/Team', 'kb/team/Twin')).toBe(
      'Nothing can be moved into itself: "kb/team/Twin" is inside "kb/Team". Choose a destination outside "kb/Team".',
    );
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

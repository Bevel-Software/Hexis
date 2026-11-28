import { describe, it, expect } from 'vitest';
import { moveIntoItselfRefusal } from '@bevel-software/platform-shared';

describe('moveIntoItselfRefusal', () => {
  it('refuses a child and a deeper destination with one sentence', () => {
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Team')).toBe(
      'Nothing can be moved into itself: "kb/Team/Team" is inside "kb/Team". Choose a destination outside "kb/Team".',
    );
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/Twin/Team')).not.toBeNull();
  });

  it('reads other spellings of a path inside the source as inside it', () => {
    expect(moveIntoItselfRefusal('kb/Team/', 'kb//Team/./Twin/')).toContain('"kb/Team/Twin" is inside "kb/Team"');
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Other/../Team/Twin')).toContain('is inside "kb/Team"');
    expect(moveIntoItselfRefusal('kb\\Team', 'kb/Team\\Twin')).not.toBeNull();
  });

  it('lets through a sibling with the same prefix, another case, the parent, and the source itself', () => {
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team2/Team')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team', 'kb/team/Twin')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team/Twin', 'kb/Team')).toBeNull();
    expect(moveIntoItselfRefusal('kb/Team', 'kb/Team/')).toBeNull();
  });
});

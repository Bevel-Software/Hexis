import { describe, it, expect } from 'vitest';
import { isNamedGroup, pathForGroupMembers } from '../components/group-members-path';

/** A `?group=` link names a group the way the backend does: case and inner whitespace aside. */
describe('isNamedGroup', () => {
  const entry = { canonical: 'platform team', displayName: 'Platform Team' };

  it('matches the display name and the canonical name without regard to case', () => {
    expect(isNamedGroup(entry, 'platform team')).toBe(true);
    expect(isNamedGroup(entry, 'PLATFORM TEAM')).toBe(true);
  });

  it('matches a name whose inner whitespace differs, as the backend folds it', () => {
    expect(isNamedGroup(entry, 'Platform  Team')).toBe(true);
    expect(isNamedGroup(entry, ' Platform\tTeam ')).toBe(true);
  });

  it('is false for another group, or no name', () => {
    expect(isNamedGroup(entry, 'Platform')).toBe(false);
    expect(isNamedGroup(entry, null)).toBe(false);
  });

  it('round-trips through the link it builds', () => {
    const url = new URL(pathForGroupMembers('Platform Team'), 'http://x');
    expect(isNamedGroup(entry, url.searchParams.get('group'))).toBe(true);
  });
});

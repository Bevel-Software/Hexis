import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { personalGroupName } from '../utils/personal-group';

/**
 * What a card says when it has nothing to report, and what it says when it has.
 *
 * The rule under test: the footer is EARNED. A tool always states its
 * connection because that is the only question anyone asks of a tool; a skill
 * says nothing unless something is in its way. Neither ever labels its own kind
 * — "SKILL" under a skill is a word spent restating the obvious.
 */

function card(over: Partial<LibraryCardProps> = {}) {
  const props: LibraryCardProps = {
    kind: 'skill',
    id: 'rfi',
    name: 'rfi',
    description: 'Answers an RFI.',
    owned: false,
    status: { state: 'ok', text: 'Ready' },
    onOpen: vi.fn(),
    ...over,
  };
  render(<LibraryCard {...props} />);
}

describe('LibraryCard', () => {
  it('never labels its own kind', () => {
    card({ kind: 'skill' });
    expect(screen.queryByText(/^Skill$/i)).not.toBeInTheDocument();

    cleanup();
    card({ kind: 'integration', id: 'slack', name: 'slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.queryByText(/^Integration$/i)).not.toBeInTheDocument();
  });

  it('says nothing about a healthy skill', () => {
    card({ kind: 'skill', status: { state: 'ok', text: 'Ready' } });
    // Not even "Ready": a green word on every skill in the grid is a row of
    // noise that buries the two cards that actually need somebody.
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('names what is in a blocked skill’s way', () => {
    card({ kind: 'skill', status: { state: 'warn', text: 'Needs slack' } });
    expect(screen.getByText('Needs slack')).toBeInTheDocument();
  });

  it('always states a tool’s connection, either way', () => {
    card({ kind: 'integration', id: 'slack', name: 'slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.getByText('Connected')).toBeInTheDocument();

    cleanup();
    card({
      kind: 'integration',
      id: 'notion',
      name: 'notion',
      status: { state: 'warn', text: 'Needs your sign-in' },
    });
    expect(screen.getByText('Needs your sign-in')).toBeInTheDocument();
  });

  it('carries a version when the skill declares one', () => {
    card({ version: '1.4.0' });
    expect(screen.getByText('v1.4.0')).toBeInTheDocument();
  });

  it('shows no version for the many skills that declare none', () => {
    // Absence is the normal case — `version:` is optional in `SKILL.md`, and
    // no skill in the shipped KB sets it. An empty slot, not a placeholder.
    card({ version: undefined });
    expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
  });

  it('still marks what you own', () => {
    card({ owned: true });
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});

describe('personalGroupName', () => {
  it('uses the first name, as a colleague would say it out loud', () => {
    expect(personalGroupName('Juan Viera')).toBe("Juan's Group");
    expect(personalGroupName('juan')).toBe("Juan's Group");
  });

  it('still names the place when nobody is signed in', () => {
    // The space exists either way and still needs a heading — and "Yours" is
    // true for whoever is reading it.
    expect(personalGroupName(null)).toBe('Yours');
    expect(personalGroupName('   ')).toBe('Yours');
  });
});

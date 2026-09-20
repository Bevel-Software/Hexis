import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { displayFirstName, personalPluginName } from '../utils/personal-plugin';

/**
 * What a card says when it has nothing to report, and what it says when it has.
 *
 * The rule under test: the footer is EARNED. A tool always states its
 * connection because that is the only question anyone asks of a tool; a skill
 * says nothing unless something is in its way. Neither ever labels its own kind
 * — "SKILL" under a skill is a word spent restating the obvious.
 */

function card(over: Partial<LibraryCardProps> = {}) {
  // The cast, not a typed literal: `LibraryCardProps` is a discriminated
  // union on `kind`, and a base-plus-overrides spread cannot be proven to
  // land on one arm. Integration overrides still pass `flavor`, as the union
  // demands of real callers.
  const props = {
    kind: 'skill',
    id: 'rfi',
    name: 'rfi',
    description: 'Answers an RFI.',
    owned: false,
    status: { state: 'ok', text: 'Ready' },
    onOpen: vi.fn(),
    ...over,
  } as LibraryCardProps;
  render(<LibraryCard {...props} />);
}

/**
 * The badges in a card's title row — the round chips, which is what separates
 * them from the monogram's rounded square sitting in the same row. Both are
 * `shrink-0`, and how many of them share the row is exactly what decides how
 * much width is left for the one item that can shrink: the name.
 */
function badgesIn(titleRow: Element): Element[] {
  return [...titleRow.children].filter((el) => el.className.includes('rounded-full'));
}

describe('LibraryCard', () => {
  it('never labels its own kind', () => {
    card({ kind: 'skill' });
    expect(screen.queryByText(/^Skill$/i)).not.toBeInTheDocument();

    cleanup();
    card({ kind: 'integration', flavor: 'utcp', id: 'slack', name: 'slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.queryByText(/^Integration$/i)).not.toBeInTheDocument();
  });

  /**
   * The one label an integration DOES carry: how it is declared, because that
   * decides which file an owner edits. Required by the props union — an
   * optional here shipped cards silently missing the badge.
   */
  it('says how an integration is declared', () => {
    card({ kind: 'integration', flavor: 'mcp', id: 'linear', name: 'linear', status: { state: 'ok', text: 'Connected' } });
    expect(screen.getByText('MCP server')).toBeInTheDocument();

    cleanup();
    card({ kind: 'integration', flavor: 'utcp', id: 'slack', name: 'slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.getByText('UTCP manual')).toBeInTheDocument();
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
    card({ kind: 'integration', flavor: 'utcp', id: 'slack', name: 'slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.getByText('Connected')).toBeInTheDocument();

    cleanup();
    card({
      kind: 'integration',
      flavor: 'utcp',
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

  /**
   * A skill's lifecycle is its authors' business, not the platform's, and the
   * card lost the `deprecated`/`retired` badge with it.
   *
   * Scope, so this is not read as more than it is: the removal PROPER is
   * pinned a layer up, in `library-data.mapping.test.tsx` — no `lifecycle`
   * survives the catalog mapping, so no card can be handed one by the real
   * data flow. This is the re-introduction guard on the rendering itself,
   * and the cast is deliberate: the prop is gone from `LibraryCardProps`, so
   * a caller reaching for it again has to come back through this door.
   */
  it('renders no lifecycle badge, even when handed the removed prop', () => {
    card({ lifecycle: 'retired' } as Partial<LibraryCardProps>);
    expect(screen.queryByText(/^Deprecated$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Retired$/i)).not.toBeInTheDocument();
  });

  /**
   * A proposed skill — one that exists only on an open change request.
   *
   * Before this, a skill an agent proposed was in the product nowhere at all
   * until somebody merged it: the catalog reads the default branch, and the
   * request had not landed there. The card is the fix, and what it has to say
   * differs by who is reading it — the author is waiting on somebody, the
   * approver IS the somebody.
   */
  it('says a proposed skill is in review, and who it is between', () => {
    card({ pending: { authorName: 'Ali Raza', mine: false } });
    expect(screen.getByText('In review')).toBeInTheDocument();
    expect(screen.getByText(/From Ali Raza: waiting on you/)).toBeInTheDocument();

    cleanup();
    card({ pending: { authorName: 'Ali Raza', mine: true } });
    expect(screen.getByText('Waiting on approval')).toBeInTheDocument();
    expect(screen.queryByText(/waiting on you/)).not.toBeInTheDocument();
  });

  it('does not report integration status on something nobody has approved', () => {
    // The status line is about a skill's integrations. On a proposal it would
    // answer a question nobody is asking yet, over the one thing to know: that
    // it is not usable.
    card({ status: { state: 'warn', text: 'Needs slack' }, pending: { authorName: 'Ali', mine: true } });
    expect(screen.queryByText('Needs slack')).not.toBeInTheDocument();
  });

  /**
   * A proposed TOOL — a `.tool` manual or an `mcp.json` server that exists only
   * on an open change request, the same hole the skill card above fixed. It
   * wears the same review badge and the same dashed outline, because it is the
   * same fact.
   *
   * What it does NOT wear is the flavour badge. A released card carries it to
   * answer "which file do I edit", and a proposal has no file to edit yet —
   * the change request the card opens shows the reviewer the declaration
   * itself. Drawing both cost the name its room (see the badge-count test
   * below), so the row spends its one badge on the fact that matters here.
   */
  it('marks a proposed tool in review without claiming it is connected', () => {
    card({
      kind: 'integration',
      flavor: 'mcp',
      id: 'tickets',
      name: 'tickets',
      // The connection state a released tool always states. On a proposal
      // "Needs setup" would send the reader off to configure a credential for
      // a server nobody has approved.
      status: { state: 'warn', text: 'Needs setup' },
      pending: { authorName: 'Ali Raza', mine: false },
    });
    expect(screen.getByText('In review')).toBeInTheDocument();
    expect(screen.getByText(/From Ali Raza: waiting on you/)).toBeInTheDocument();
    expect(screen.queryByText('Needs setup')).not.toBeInTheDocument();
    // The flavour badge stays off, on the mcp side as on the utcp side the
    // badge-count test below covers — so the comment above is checked here
    // rather than merely asserted in prose.
    expect(screen.queryByText('MCP server')).not.toBeInTheDocument();
    // Dashed: the card is an outline of a tool rather than one, and that reads
    // before any text does.
    expect(screen.getByTestId('library-card-integration-tickets').className).toContain(
      'border-dashed',
    );
  });

  /**
   * The title row of a tool card fits ONE badge, and this is the regression
   * that proved it: a proposal drew the flavour badge and `In review` side by
   * side, and since both are `shrink-0` beside a `shrink-0` monogram, the
   * truncating name absorbed the whole deficit — `prometheus_metrics` rendered
   * as `p…` in a 260px grid track.
   *
   * jsdom has no layout, so this cannot be asserted in pixels. The structural
   * cause can be: how many things in that row refuse to shrink. That is the
   * invariant worth holding, because it is the one that was broken.
   */
  it('spends only one badge on a proposed tool’s title row', () => {
    card({
      kind: 'integration',
      flavor: 'utcp',
      id: 'prometheus_metrics',
      name: 'prometheus_metrics',
      status: { state: 'ok', text: 'Connected' },
      pending: { authorName: 'Ali Raza', mine: true },
    });
    // Badges are the round chips (`rounded-full`); the monogram beside them is
    // a rounded SQUARE, and it is `shrink-0` too — so counting badges, not
    // every rigid child, is what names the thing that overflowed.
    expect(badgesIn(screen.getByText('prometheus_metrics').parentElement!)).toHaveLength(1);
    // And it is the badge that says the tool is not here yet — the flavour
    // names which file an owner edits, which is a question about a released
    // tool; a reviewer is shown that file by the change request itself.
    expect(screen.getByText('In review')).toBeInTheDocument();
    expect(screen.queryByText('UTCP manual')).not.toBeInTheDocument();

    // A RELEASED tool keeps its flavour badge — this is the proposal's
    // arrangement, not a retreat from saying how a tool is declared.
    cleanup();
    card({
      kind: 'integration',
      flavor: 'utcp',
      id: 'prometheus_metrics',
      name: 'prometheus_metrics',
      status: { state: 'ok', text: 'Connected' },
    });
    expect(screen.getByText('UTCP manual')).toBeInTheDocument();
  });

  /**
   * A name the row had to clip is still readable on hover. Truncation is the
   * intended outcome in a fixed grid track; an unreadable card is not.
   */
  it('carries the full name as a tooltip, however the row clips it', () => {
    card({ id: 'prometheus_metrics', name: 'prometheus_metrics' });
    expect(screen.getByText('prometheus_metrics')).toHaveAttribute(
      'title',
      'prometheus_metrics',
    );
  });

  it('does not call a proposal yours to own', () => {
    // `Owner` means you can change the released skill. There is no released
    // skill, so the two badges would contradict each other in one row.
    card({ owned: true, pending: { authorName: 'Ali', mine: true } });
    expect(screen.queryByText('Owner')).not.toBeInTheDocument();
    expect(screen.getByText('In review')).toBeInTheDocument();
  });
});

describe('personalPluginName', () => {
  it('is one name for everyone — the page is always the reader\'s own', () => {
    expect(personalPluginName()).toBe('Personal plugin');
  });
});

describe('displayFirstName', () => {
  // A sign-in record is not a style guide: an account created from a lowercase
  // name should still be greeted the way a person writes their own.
  it('capitalizes the first name', () => {
    expect(displayFirstName('juan viera')).toBe('Juan');
    expect(displayFirstName('Juan Viera')).toBe('Juan');
    expect(displayFirstName('  juan  ')).toBe('Juan');
  });

  // Empty rather than a fallback, because the two callers want different
  // words for it — "Yours" on the plugin heading, "there" on the welcome page.
  it('gives nothing back when there is no name, and lets the caller decide', () => {
    expect(displayFirstName(null)).toBe('');
    expect(displayFirstName(undefined)).toBe('');
    expect(displayFirstName('   ')).toBe('');
  });
});

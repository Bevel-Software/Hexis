import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { Badge } from '../../../shared/components';
import { NameWithBadges, NAME_MIN_WIDTH } from '../components/NameWithBadges';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { PluginIndexRow } from '../components/PluginIndexRow';

/**
 * The name wins the row.
 *
 * The bug: a tool card 236px wide rendered "di…" — the name was `truncate`
 * and the four badges beside it were `shrink-0`, so the whole of the row's
 * shortfall came out of the one part of it anybody was reading.
 *
 * jsdom has no layout, so none of this can be asserted in pixels. What CAN be
 * asserted is the contract the layout is made of, and it is not a stylistic
 * one: the floor (`min-w-[12ch]`) is what stops the name shrinking, `flex-1`
 * is what makes flexbox measure the name AT that floor when it decides where
 * to break, and `flex-wrap` is what gives the badges a second line to break
 * onto. Remove any one and the card says "di…" again with every test green.
 * The pixels are Manual QA's half of the same contract.
 */

const LONG_NAME = 'disposable-weather-lookup-for-the-northern-hemisphere-v2beta';

afterEach(cleanup);

/**
 * The row's parts, addressed the way the layout addresses them. Keyed on the
 * name's own `title` rather than on a position: badges carry titles of their
 * own (`Linked` names the folder it came from), so "the first titled element"
 * would quietly start meaning a different element the day the order changed.
 */
function parts(root: HTMLElement, name: string) {
  const nameEl = root.querySelector(`[title="${name}"]`) as HTMLElement | null;
  const row = (nameEl?.parentElement ?? null) as HTMLElement | null;
  return { row, nameEl };
}

describe('NameWithBadges', () => {
  it('is 60 characters long and still says who it is', () => {
    // The ticket's own case. The name is in the DOM whole — the truncation is
    // `text-overflow`, so a screen reader reads all of it — and `title` is
    // where the reader who only has the ellipsis can find the rest.
    expect(LONG_NAME).toHaveLength(60);
    const { container } = render(
      <NameWithBadges name={LONG_NAME} badges={<Badge>Owner</Badge>} />,
    );

    const name = screen.getByTitle(LONG_NAME);
    expect(name).toHaveTextContent(LONG_NAME);
    expect(name.className).toContain('truncate');
    expect(container.firstElementChild?.className).toContain('flex-wrap');
  });

  it('gives the name a floor while badges are beside it', () => {
    render(<NameWithBadges name={LONG_NAME} badges={<Badge>Owner</Badge>} />);
    const name = screen.getByTitle(LONG_NAME);
    // The floor, and the thing that makes flexbox read the floor as the
    // name's size when it decides where to break the line.
    expect(name.className).toContain(NAME_MIN_WIDTH);
    expect(name.className).toContain('flex-1');
  });

  it('moves the badges as a group rather than squeezing them', () => {
    const { container } = render(
      <NameWithBadges
        name={LONG_NAME}
        badges={
          <>
            <Badge>Owner</Badge>
            <Badge>Linked</Badge>
          </>
        }
      />,
    );

    const group = screen.getByText('Owner').parentElement as HTMLElement;
    expect(within(group).getByText('Linked')).toBeInTheDocument();
    expect(group).not.toBe(container.firstElementChild);
    // `shrink-0` is the half that makes a badge move instead of shrink;
    // `max-w-full` is the half that keeps the moved group inside the row.
    expect(group.className).toContain('shrink-0');
    expect(group.className).toContain('max-w-full');
  });

  it('gives a name with nothing beside it no floor to overflow on', () => {
    // Nothing to wrap ⇒ a floor could only push the name out of its own
    // container. A lone name simply truncates, which is what it always did.
    const { container } = render(<NameWithBadges name={LONG_NAME} />);
    const name = screen.getByTitle(LONG_NAME);
    expect(name.className).not.toContain(NAME_MIN_WIDTH);
    expect(name.className).toContain('truncate');
    // One child, and it is the name: there is no badge group to break onto a
    // second line, which is the whole reason the floor is withheld.
    expect(container.firstElementChild!.children).toHaveLength(1);
  });

  it('does not spend the floor on a mark, which cannot move', () => {
    // The floor is a claim on space something else has to give back, and a
    // badge is the only thing here that can — it takes a second line. A mark
    // is fixed width on the name's own line, so a floor granted for one is a
    // minimum width with no matching concession: the row just gets wider than
    // its box. That is precisely how the tool page's title bar came to render
    // outside its own band.
    render(<NameWithBadges name={LONG_NAME} leading={<span data-testid="mark" />} />);
    const name = screen.getByTitle(LONG_NAME);
    expect(name.className).not.toContain(NAME_MIN_WIDTH);
    expect(screen.getByTestId('mark')).toBeInTheDocument();
  });

  it('can be told its row is one line tall and may not wrap', () => {
    // For a caller whose height is a contract it does not own — the tool
    // page's title bar is exactly as tall as the sidebar header row beside
    // it, so a second line does not grow the band, it hangs out of it.
    const { container } = render(
      <NameWithBadges name={LONG_NAME} wrap={false} badges={<Badge>Owner</Badge>} />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('flex-nowrap');
    expect(row.className).not.toContain('flex-wrap ');
  });

  it('opens no tooltip on a name that is missing', () => {
    // `.tool` files without a `name:` fall back to whatever the path gives,
    // which can be nothing. `title=""` is a tooltip that opens on emptiness;
    // the row still renders, and the badges still sit where they sat.
    const { container } = render(<NameWithBadges name="" badges={<Badge>Owner</Badge>} />);
    expect(container.querySelector('[title]')).toBeNull();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});

function card(over: Partial<LibraryCardProps> = {}) {
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
  return render(<LibraryCard {...props} />);
}

describe('LibraryCard: the name keeps its width', () => {
  it('holds a 60-character tool name to the floor, badges and all', () => {
    const { container } = card({
      kind: 'integration',
      flavor: 'utcp',
      id: 'weather',
      name: LONG_NAME,
      owned: true,
      linkedHome: 'Tools/Weather',
      status: { state: 'ok', text: 'Connected' },
    });

    const { row, nameEl } = parts(container.firstElementChild as HTMLElement, LONG_NAME);
    expect(nameEl).toHaveTextContent(LONG_NAME);
    expect(nameEl!.className).toContain(NAME_MIN_WIDTH);
    expect(row!.className).toContain('flex-wrap');
    // Req 4: which badges show is untouched by the layout change.
    expect(screen.getByText('UTCP manual')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Linked')).toBeInTheDocument();
  });

  it('leaves a bare skill card exactly as it was', () => {
    // No mark, no badges, nothing to wrap. The name truncates and says the
    // rest on hover — and takes no floor it has no use for.
    const { container } = card({ name: LONG_NAME });
    const { nameEl } = parts(container.firstElementChild as HTMLElement, LONG_NAME);
    expect(nameEl).toHaveTextContent(LONG_NAME);
    expect(nameEl!.className).not.toContain(NAME_MIN_WIDTH);
  });

  it('keeps two tools of the same name apart', () => {
    // Same display name, different plugins — the catalog allows it, and the
    // card has to stay addressable and readable either way. Identity is the
    // SLUG, which is what the test id and the open handler are keyed on; the
    // name is only what the row shows.
    const gtm = vi.fn();
    const ops = vi.fn();
    render(
      <>
        <LibraryCard
          kind="integration"
          flavor="utcp"
          id="gtm-weather"
          name={LONG_NAME}
          description="The GTM plugin's copy."
          owned={false}
          status={{ state: 'ok', text: 'Connected' }}
          onOpen={gtm}
        />
        <LibraryCard
          kind="integration"
          flavor="mcp"
          id="ops-weather"
          name={LONG_NAME}
          description="The Ops plugin's copy."
          owned={false}
          status={{ state: 'warn', text: 'Needs your sign-in' }}
          onOpen={ops}
        />
      </>,
    );

    const first = screen.getByTestId('library-card-integration-gtm-weather');
    const second = screen.getByTestId('library-card-integration-ops-weather');
    for (const el of [first, second]) {
      expect(parts(el, LONG_NAME).nameEl).toHaveTextContent(LONG_NAME);
      expect(parts(el, LONG_NAME).nameEl!.className).toContain(NAME_MIN_WIDTH);
    }
    // The foot note is what tells them apart on screen, and it still does.
    expect(within(first).getByText('Connected')).toBeInTheDocument();
    expect(within(second).getByText('Needs your sign-in')).toBeInTheDocument();
    expect(within(first).getByText("The GTM plugin's copy.")).toBeInTheDocument();
    expect(within(second).getByText("The Ops plugin's copy.")).toBeInTheDocument();
  });
});

describe('PluginIndexRow: the same rule, one line tall', () => {
  it('holds a long plugin name to the floor beside its chips', () => {
    render(
      <PluginIndexRow
        label={LONG_NAME}
        badge={<Badge>Owner</Badge>}
        meta="4 skills · 2 tools"
        onOpen={vi.fn()}
      />,
    );

    const name = screen.getByTitle(LONG_NAME);
    expect(name).toHaveTextContent(LONG_NAME);
    expect(name.className).toContain(NAME_MIN_WIDTH);
    expect(name.parentElement!.className).toContain('flex-wrap');
  });

  it('is laid out in a track that can actually run short', () => {
    // Measured in chromium before this was here: a row wearing a
    // 60-character name laid itself out 605px wide inside a 200px column
    // and hung out of it at every window size. `ItemMenuFrame` is a grid,
    // and its implicit column was `auto` — a track whose minimum is the
    // content's min-content, which for a `whitespace-nowrap` name is the
    // whole name. `min-w-0` does not reach it: that bounds the grid box,
    // not the track inside it.
    //
    // It is this row, not the name, that the wrap depends on. A row that is
    // never short never has a shortfall, and badges that are never short of
    // room never move. With the track floored at 0 the row is the width of
    // its column (200px at a 236px window, measured), and the badges take
    // their second line.
    const { container } = render(
      <PluginIndexRow label={LONG_NAME} badge={<Badge>Owner</Badge>} onOpen={vi.fn()} />,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain('grid-cols-[minmax(0,1fr)]');
  });
  it('says the whole name on a row that carries no chip at all', () => {
    // The row used to pass its label through as a bare string, so a plugin
    // whose name the row had to truncate had nowhere to finish saying it.
    render(<PluginIndexRow label={LONG_NAME} meta="4 skills · 2 tools" onOpen={vi.fn()} />);
    const name = screen.getByTitle(LONG_NAME);
    expect(name).toHaveTextContent(LONG_NAME);
    expect(name.className).not.toContain(NAME_MIN_WIDTH);
  });
});

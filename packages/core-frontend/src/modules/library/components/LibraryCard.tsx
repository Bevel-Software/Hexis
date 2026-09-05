import { Badge, Surface } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { StatusDot } from './StatusDot';
import { ToolLogo } from './ToolLogo';
import type { AttentionStatus, GemState } from '../utils/status';

/**
 * A discriminated union on `kind`, not a bag of optionals: an integration
 * MUST say its flavor (a card silently missing the badge would compile fine
 * with an optional), and a skill must not be able to carry one.
 */
export type LibraryCardProps = LibraryCardCommonProps &
  (
    | { kind: 'skill'; flavor?: never }
    | {
        kind: 'integration';
        /**
         * How the integration is declared: an `mcp.json` server or a `.tool`
         * UTCP manual. Two different files to edit and two different
         * capability sets, so the card says which one this is.
         */
        flavor: 'mcp' | 'utcp';
      }
  );

export interface LibraryCardCommonProps {
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
  /**
   * The skill's declared `version:` frontmatter, when it has one. Most skills
   * do not, so this slot is empty far more often than it is full — which is
   * why it is a quiet right-aligned note and not a badge.
   */
  version?: string;
  /**
   * Set only on a skill that does not exist yet — it is on an open change
   * request, waiting to be approved. `mine` distinguishes the two readers this
   * card has: the person who proposed it (waiting on someone else) and the
   * person who has to decide (being waited on).
   */
  pending?: { authorName: string; mine: boolean };
  /**
   * A skill's governance lifecycle (`metadata.lifecycle`). Only the two states
   * that need a reader's attention are shown — `deprecated` (still works,
   * find the replacement) and `retired` (kept for its owners, never
   * distributed); `active` and absence render nothing.
   */
  lifecycle?: string;
  /** Open the item. The whole card is the target. */
  onOpen(): void;
}

const STATUS_INK: Record<GemState, string> = {
  ok: 'text-ok',
  warn: 'text-wait',
  err: 'text-danger',
};

/**
 * One gallery card — the prototype's `.card` (line 158).
 *
 * The whole card is one `<button>` that opens the item, which is why there is
 * no ⓘ affordance any more: it used to exist because the card body was spent
 * on toggling loadout membership, so opening needed its own target. With the
 * loadout gone the card has a single action, and a card with a single action
 * should not have two controls.
 *
 * The two-line clamp on the description is load-bearing, not cosmetic. Skill
 * descriptions run to full paragraphs, so without it a card grows to whatever
 * its longest text needs and the grid stops being a grid. `min-h` sets the
 * floor, the clamp sets the ceiling, and every card lands between them.
 */
export function LibraryCard({
  kind,
  id,
  name,
  description,
  owned,
  status,
  version,
  pending,
  lifecycle,
  onOpen,
  flavor,
}: LibraryCardProps) {
  /**
   * What the bottom-left says, and when it says anything at all.
   *
   * A TOOL always states its connection, because that is the only question
   * anyone asks of a tool and the answer changes without warning — `Connected`
   * or `Needs …`, never a third thing.
   *
   * A SKILL is silent unless something is in its way. A skill has no state of
   * its own to report; a green "Ready" on every skill in the grid is a row of
   * noise that says nothing, and it buries the two cards that DO need you.
   *
   * A PROPOSED skill overrides both, because the one thing to know about it is
   * that it is not usable yet — and by whose hand it got here. The status it
   * carries is about integrations and has nothing to say about a file nobody
   * has approved.
   */
  const footNote = pending
    ? null
    : kind === 'integration' || status.state !== 'ok'
      ? status
      : null;

  return (
    <Surface
      as="button"
      type="button"
      data-testid={`library-card-${kind}-${id}`}
      interactive
      padded
      // Dashed, because the card is an outline of a skill rather than one: the
      // border says "not here yet" before any text is read, and it survives the
      // badge being missed at a glance.
      // `min-w-0`: the card sits in a grid (or the remove-overlay's wrapper),
      // and a grid item's automatic minimum is its content's min-content width
      // — a long tool name plus its badges would make the card WIDER than its
      // track and paint under the neighbouring card. Allowing the card to
      // shrink is what lets the name's `truncate` actually engage.
      className={cn(
        'flex min-h-28 min-w-0 flex-col gap-1.5 text-left',
        pending && 'border-dashed',
      )}
      onClick={onOpen}
    >
      <span className="flex items-center gap-2">
        {/* Only tools carry a mark. A skill has no brand to recognise — its
            name IS the thing — and a monogram beside every skill would add a
            column of coloured squares that distinguish nothing. */}
        {kind === 'integration' && <ToolLogo slug={id} name={name} />}
        <span className="truncate text-lede font-semibold text-ink">{name}</span>
        {kind === 'integration' && flavor && (
          <Badge tone="outline" size="xs" className="shrink-0 uppercase">
            {flavor === 'mcp' ? 'MCP server' : 'UTCP manual'}
          </Badge>
        )}
        {pending && (
          <Badge tone="wait" size="xs" className="shrink-0 uppercase">
            In review
          </Badge>
        )}
        {owned && !pending && (
          <Badge tone="outline" size="xs" className="shrink-0 uppercase">
            Owner
          </Badge>
        )}
        {(lifecycle === 'deprecated' || lifecycle === 'retired') && (
          <Badge tone="wait" size="xs" className="shrink-0 uppercase">
            {lifecycle === 'retired' ? 'Retired' : 'Deprecated'}
          </Badge>
        )}
      </span>

      {description && (
        <span className="line-clamp-2 text-detail text-ink-muted">{description}</span>
      )}

      {/* The foot exists only when it has something to say. An empty strip
          still costs the two lines of description their room, so a healthy
          skill with no version simply ends after its description — which is
          what makes the cards that DO carry a note stand out at a glance. */}
      {/* A proposal's foot names the person the decision is between. "Waiting
          on approval" to its author and "waiting on you" to whoever can give
          it are the same fact told to the two people who can act on it — and
          neither is served by the generic status line above. */}
      {(footNote || version || pending) && (
        <span className="mt-auto flex items-center gap-1.5 pt-2 text-meta text-ink-faint">
          {pending && (
            <span className="truncate font-semibold text-wait">
              {pending.mine
                ? 'Waiting on approval'
                : `From ${pending.authorName}: waiting on you`}
            </span>
          )}
          {footNote && (
            /* `title` carries the evidence behind the word — what the provider
               said, or when it was last checked. A card has room for one word;
               the sentence that justifies it belongs on hover. */
            <span
              className={cn('flex items-center gap-1.5 font-semibold', STATUS_INK[footNote.state])}
              title={footNote.hint}
            >
              <StatusDot state={footNote.state} />
              {footNote.text}
            </span>
          )}
          {/* `ml-auto` on the version, not on the status: the version is the
              thing pinned right, and it has to stay pinned there whether or
              not a status is sharing the row. */}
          {version && <span className="ml-auto shrink-0 tabular-nums">v{version}</span>}
        </span>
      )}
    </Surface>
  );
}

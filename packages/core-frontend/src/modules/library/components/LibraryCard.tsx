import { ExternalLink, Users } from 'lucide-react';
import { Badge, Surface } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { ItemMenuFrame } from './ItemActionsMenu';
import { NameWithBadges } from './NameWithBadges';
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
    | {
        kind: 'skill';
        flavor?: never;
        /**
         * Open Manage access on the skill's own folder — the skill page's
         * `Share`, offered from the card. Absent when the surface the card is
         * on cannot address that folder (the KB directory has not resolved) or
         * the skill has none yet (a proposal lives on a branch), and the card
         * then carries no menu at all.
         */
        onShare?(): void;
      }
    | {
        kind: 'integration';
        /**
         * How the integration is declared: an `mcp.json` server or a `.tool`
         * UTCP manual. Two different files to edit and two different
         * capability sets, so the card says which one this is.
         */
        flavor: 'mcp' | 'utcp';
        /**
         * Never. Access to a tool is decided at the plugin that carries it, so
         * a tool card has nothing of its own to share. Stated in the type, so a
         * caller that tries is a compile error rather than a card that grew a
         * menu nobody meant it to have.
         */
        onShare?: never;
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
  /**
   * Where the item LIVES, when it reaches the page showing this card through
   * a link rather than by sitting in its folder — `Skills/Testing`. Draws the
   * Linked pill, with that folder in its tooltip.
   *
   * Set only on a plugin's page, and only for a linked card: a gallery card
   * is in as many plugins as it is in, and "linked" there would name no
   * plugin to be linked from. Absent ⇒ no pill, which is every inline card.
   */
  linkedHome?: string;
  /** Open the item. The whole card is the target. */
  onOpen(): void;
}

const STATUS_INK: Record<GemState, string> = {
  ok: 'text-ok',
  warn: 'text-wait',
  urgent: 'text-urgent',
  err: 'text-danger',
};

/**
 * One gallery card — the prototype's `.card` (line 158).
 *
 * The whole card BODY is one `<button>` that opens the item — the ⓘ affordance
 * that used to sit beside it is gone, because it only existed while the body
 * was spent on toggling loadout membership and opening needed its own target.
 *
 * The one control that did earn a place back is the `…` menu, and only on a
 * card that has a second verb to offer: Share is a decision about who else can
 * see the skill, and the index is where a reader is looking at the skill they
 * want to share. It is a SIBLING of the card button, never a child — a button
 * inside a button is not markup — which is what `ItemMenuFrame` exists to
 * arrange. A card with no `onShare` is the card this file has always rendered.
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
  linkedHome,
  onOpen,
  onShare,
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

  /**
   * The chips that qualify the name — as an ARRAY, not a fragment.
   *
   * `NameWithBadges` gives the name its minimum width only while something is
   * actually competing with it for the row, and a fragment of five falsy
   * branches is indistinguishable from a fragment of five pills. An array can
   * be counted. Which badges appear is untouched: these are the same five
   * conditions, in the same order, that this row has always rendered.
   */
  const badges = [
    kind === 'integration' && flavor ? (
      <Badge key="flavor" tone="outline" size="xs" className="shrink-0 uppercase">
        {flavor === 'mcp' ? 'MCP server' : 'UTCP manual'}
      </Badge>
    ) : null,
    pending ? (
      <Badge key="pending" tone="wait" size="xs" className="shrink-0 uppercase">
        In review
      </Badge>
    ) : null,
    owned && !pending ? (
      <Badge key="owner" tone="outline" size="xs" className="shrink-0 uppercase">
        Owner
      </Badge>
    ) : null,
    /* The card is on a plugin's page and the item lives somewhere else. The
       Owner pill's exact dress, because it makes the same kind of statement —
       a fact about the item's standing, not a problem — and the skill's own
       page already spells LINKED this way.

       The pill alone would say "not here" without saying where, and "where" is
       the whole reason the reader is puzzled: the Advanced tree shows the disk,
       so a linked skill is not under the plugin's folder there, and the tooltip
       is what reconciles the two views. */
    linkedHome ? (
      <Badge
        key="linked"
        tone="outline"
        size="xs"
        className="shrink-0 uppercase"
        title={`Lives in ${linkedHome}; linked from this plugin's manifest`}
      >
        Linked
      </Badge>
    ) : null,
    lifecycle === 'deprecated' || lifecycle === 'retired' ? (
      <Badge key="lifecycle" tone="wait" size="xs" className="shrink-0 uppercase">
        {lifecycle === 'retired' ? 'Retired' : 'Deprecated'}
      </Badge>
    ) : null,
  ].filter((badge) => badge !== null);

  const card = (
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
      {/* Only tools carry a mark. A skill has no brand to recognise — its
          name IS the thing — and a monogram beside every skill would add a
          column of coloured squares that distinguish nothing. It goes in as
          the row's `leading` so it stays on the name's line when the badges
          leave for the one below — a logo stranded above its own name is
          worse than no logo. A tool card is never without badges anyway: the
          union makes `flavor` mandatory, so the floor is always in force
          wherever a mark is. */}
      <NameWithBadges
        leading={kind === 'integration' && <ToolLogo slug={id} name={name} />}
        name={name}
        nameClassName="text-lede font-semibold text-ink"
        badges={badges.length > 0 ? badges : undefined}
      />

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

  // A TOOL card is the card this file has always rendered, frame and all: what
  // a tool shares is decided at the plugin that carries it, so there is no
  // second verb here and never will be. Deciding on `kind` rather than on
  // whether a Share happens to have arrived yet is what keeps the markup of a
  // card stable across the loads beneath it — see `ItemMenuFrame`.
  if (kind === 'integration') return card;

  return (
    <ItemMenuFrame
      label={name}
      actions={
        onShare
          ? [
              { label: 'Open', icon: <ExternalLink size={14} />, onSelect: onOpen },
              // Below the rule, as access is in the file tree's menu and the
              // nav's: it changes who else can be here, not what is here.
              { label: 'Share', icon: <Users size={14} />, onSelect: onShare, separated: true },
            ]
          : []
      }
    >
      {card}
    </ItemMenuFrame>
  );
}

import type { ToolSecrets, ToolVarStatus } from '../../secrets-vault/services/tool-secrets.api';

/**
 * Status derivation for the Library. Everything the cards, gems and loadout
 * rows show is computed from the secrets-vault browser surface
 * (`GET /api/secrets/tools` — see `tool-secrets.api.ts`), which exposes per
 * variable: adminConfigured / userConfigured / oauth / authorized /
 * needsReauth, plus per-tool `canWrite`. Design rule from the approved mock:
 * status is only shown when something needs attention — healthy items render
 * clean.
 */

/**
 * Three states, and no fourth.
 *
 * There used to be an `off` — "not set up yet", drawn in grey. Grey reads as
 * *disabled*, or as *not your problem*: an unconfigured integration looked like
 * furniture next to the amber ones, when in fact it is the state that most
 * needs somebody. Anything that needs a person is amber; anything that was
 * working and stopped is red. Nothing that needs a person is grey.
 */
export type GemState = 'ok' | 'warn' | 'err';

export interface AttentionStatus {
  state: GemState;
  /** User-facing state line (glossary-compliant plain words). */
  text: string;
}

const OK: AttentionStatus = { state: 'ok', text: 'Connected' };

/** Severity order for aggregation: broken sign-in beats anything merely unset. */
const RANK: Record<GemState, number> = { ok: 0, warn: 1, err: 2 };

/**
 * Two states, and the words for them: `Connected`, or `Needs <the thing>`.
 *
 * There is deliberately no middle. "Not set up yet", "Sign in again to keep
 * this working" and "Needs your sign-in" were three ways of saying one thing —
 * this does not work yet — in three different shapes, so a wall of cards read
 * as several unrelated problems. Every unhealthy state now names what it wants
 * in the same grammar, which is what makes the column scannable.
 *
 * A missing key is `warn`, not a quieter state of its own: it needs a person,
 * and everything that needs a person looks the same colour.
 */
function varStatus(v: ToolVarStatus, canWrite: boolean): AttentionStatus {
  const notSetUp: AttentionStatus = {
    state: 'warn',
    text: canWrite ? 'Needs setup — yours to set up' : 'Needs setup',
  };
  if (v.oauth) {
    if (!v.adminConfigured) return notSetUp;
    if (v.authorized && v.needsReauth) return { state: 'err', text: 'Needs signing in again' };
    if (!v.authorized) return { state: 'warn', text: 'Needs your sign-in' };
    return OK;
  }
  if (v.scope === 'user') {
    return v.userConfigured ? OK : { state: 'warn', text: 'Needs a key from you' };
  }
  return v.adminConfigured ? OK : notSetUp;
}

/** Aggregate connection state of one integration for the current user. */
export function toolStatus(tool: ToolSecrets): AttentionStatus {
  let worst = OK;
  for (const v of tool.variables) {
    const s = varStatus(v, tool.canWrite);
    if (RANK[s.state] > RANK[worst.state]) worst = s;
  }
  return worst;
}

/** Per-variable status rows for the integration detail dialog. */
export function toolVariableStatuses(tool: ToolSecrets): { v: ToolVarStatus; status: AttentionStatus }[] {
  return tool.variables.map((v) => ({ v, status: varStatus(v, tool.canWrite) }));
}

/**
 * Which integrations a skill needs, derived from the skill's `allowed-tools`
 * frontmatter. Entries are agent tool names, typically namespaced by the
 * manual (`slack_post_message`, `slack.slack_post_message`) or the bare manual
 * name; generic agent tools (`Bash`, `Read`) match no manual and are ignored.
 * Best-effort by design — there is no dedicated skill→integration link in the
 * backend contract today.
 */
export function neededToolsFor(
  skill: { allowedTools?: string[] },
  tools: ToolSecrets[],
): ToolSecrets[] {
  const entries = (skill.allowedTools ?? []).map((e) => e.toLowerCase());
  if (entries.length === 0) return [];
  return tools.filter((t) => {
    const n = t.name.toLowerCase();
    return entries.some((e) => e === n || e.startsWith(`${n}_`) || e.startsWith(`${n}.`));
  });
}

/**
 * A skill is ready when every integration it needs is fully connected.
 *
 * When it is not, the status NAMES the integration in the way — the prototype's
 * `Needs {tool}` (line 1645). "Needs setup" told you a skill was blocked but
 * not by what, which left the only next step as opening the skill to find out.
 * The first unhealthy one is enough: fixing it either unblocks the skill or
 * reveals the next name.
 */
export function skillStatus(neededTools: ToolSecrets[]): AttentionStatus {
  const blocker = neededTools.find((t) => toolStatus(t).state !== 'ok');
  return blocker ? { state: 'warn', text: `Needs ${blocker.name}` } : { state: 'ok', text: 'Ready' };
}

/* ── gallery filtering ── */

/**
 * What the sidebar has selected.
 *
 * Note there is no 'skills' / 'integrations' member. The design does not split
 * the catalog by kind: a group owns its skills AND the tools those skills need,
 * so filtering to "just tools" would show a group's integrations detached from
 * the reason any of them are there. Kind is a property of a card, not a view.
 */
export type LibraryFilter =
  | { kind: 'all' }
  | { kind: 'owned' }
  | { kind: 'group'; group: string }
  /** Owned by someone, in no group — the prototype calls these "yours alone". */
  | { kind: 'ungrouped' };

/**
 * What an empty view says.
 *
 * A SEARCH that found nothing is about the search, in every view — the shelf
 * is not empty, your words just missed it. With no query the emptiness is
 * about the view itself, and each view is empty for its own reason: "Owned by
 * me" holds the things whose upkeep is yours, so its empty state says that,
 * rather than reporting a failed match nobody attempted.
 *
 * Here rather than in `LibraryPage`, because a component file that also
 * exports a plain function breaks fast refresh for the whole module.
 */
export function emptyMessageFor(filter: LibraryFilter, query: string): string {
  if (query.trim()) return 'Nothing here matches yet.';
  if (filter.kind === 'owned') return "You're not responsible for changes in any skills yet.";
  return 'Nothing here matches yet.';
}

export interface LibraryFilterable {
  kind: 'skill' | 'integration';
  name: string;
  description: string;
  owned: boolean;
  /** Folder group from the item's KB path, or null when it sits in none. */
  group: string | null;
}

/** Sidebar selection narrows; the query matches name/description within it. */
export function filterLibraryItems<T extends LibraryFilterable>(
  items: T[],
  filter: LibraryFilter,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (q && !item.name.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) {
      return false;
    }
    switch (filter.kind) {
      case 'all':
        return true;
      case 'owned':
        return item.owned;
      case 'group':
        return item.group === filter.group;
      case 'ungrouped':
        return item.group === null;
    }
  });
}

/**
 * Group names present in the catalog, with how many items each holds.
 *
 * Sorted by name rather than by count so the sidebar does not reorder itself
 * when a group gains an item — a nav that moves under the pointer is worse
 * than one that buries the biggest group in the middle.
 */
export function groupCounts<T extends LibraryFilterable>(
  items: T[],
): { group: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.group === null) continue;
    counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

import { formatRelativeTime } from '../../../lib/utils';
import type { ProbeVerdict, ToolSecrets, ToolVarStatus } from '../../secrets-vault/services/tool-secrets.api';

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
  /**
   * The sentence behind the word, for a tooltip: what the provider said, or why
   * we couldn't ask. Absent when the word is the whole story.
   *
   * This is where a status EARNS its claim. "Connected" backed by "checked 2
   * minutes ago" is a different assertion from "Connected" backed by nothing,
   * and the difference is exactly what used to be missing.
   */
  hint?: string;
}

/**
 * Stored, and PROVEN to work by a real call.
 *
 * Reachable ONLY from a passing probe verdict. Nothing derived from what is
 * merely stored may return this — that inference is the entire bug.
 */
const OK: AttentionStatus = { state: 'ok', text: 'Connected' };

/**
 * In place, and untested — all a STORED value can ever support.
 *
 * Two words rather than one because they describe two different things the
 * reader did. Green, because nothing here needs a person.
 */
const SIGNED_IN: AttentionStatus = { state: 'ok', text: 'Signed in' };
const KEY_SAVED: AttentionStatus = { state: 'ok', text: 'Key saved' };

/** Severity order for aggregation: broken sign-in beats anything merely unset. */
const RANK: Record<GemState, number> = { ok: 0, warn: 1, err: 2 };

/**
 * What ONE variable is: in place, or `Needs <the thing>`.
 *
 * Never `Connected`. This reads the vault, which knows only whether a value
 * exists — so the strongest true statement it can make is that something was
 * saved or signed into. Only a probe earns the other word.
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
    text: canWrite ? 'Needs setup: yours to set up' : 'Needs setup',
  };
  if (v.oauth) {
    if (!v.adminConfigured) return notSetUp;
    if (v.authorized && v.needsReauth) return { state: 'err', text: 'Needs signing in again' };
    if (!v.authorized) return { state: 'warn', text: 'Needs your sign-in' };
    return SIGNED_IN;
  }
  if (v.scope === 'user') {
    return v.userConfigured ? KEY_SAVED : { state: 'warn', text: 'Needs a key from you' };
  }
  return v.adminConfigured ? KEY_SAVED : notSetUp;
}

/**
 * The word for a tool that is fully SET UP, decided by whether the credential
 * has actually been tested.
 *
 * Three outcomes, and the reason there are three: `Connected` is a claim we can
 * back — something called the provider and it answered. `Key saved` is the
 * narrower claim we can back when nothing tested it: a value is stored, and
 * that is genuinely all we know. `Not working` is the provider's own verdict.
 *
 * `Key saved` stays GREEN. It is a complete, true statement about a tool that
 * needs nothing from anybody, and painting it amber would put a permanent
 * warning on every integration that simply has no way to be tested — which
 * teaches people that amber means nothing.
 *
 * A tool whose vars are oauth-backed says `Signed in` instead: the user did not
 * give us a key, they signed in, and telling them a key was saved is a small
 * lie in a component whose entire job is to stop telling small lies.
 */
function healthStatus(tool: ToolSecrets, verdict?: ProbeVerdict | null): AttentionStatus {
  if (verdict?.status === 'ok') {
    // The app's one relative-time formatter, not a local dialect of it. A
    // verdict with no usable timestamp still just happened — it cannot outlive
    // the component holding it — so "just now" is the honest fallback.
    return { ...OK, hint: `Checked ${formatRelativeTime(verdict.checkedAt) || 'just now'}.` };
  }
  if (verdict?.status === 'failed') {
    return {
      state: 'err',
      text: 'Not working',
      hint: verdict.detail ?? 'The provider rejected this credential.',
    };
  }
  // The word has to match what the user actually did. A tool with no variables
  // asked nothing of them, so "Key saved" would name a key that does not exist;
  // an oauth-backed one got a sign-in, not a key. Same claim in all three cases
  // — something is in place, nothing has tested it — said in the reader's terms.
  const allOAuth = tool.variables.length > 0 && tool.variables.every((v) => v.oauth);
  const text =
    tool.variables.length === 0 ? 'No key needed' : allOAuth ? 'Signed in' : 'Key saved';
  return {
    state: 'ok',
    text,
    hint: verdict?.detail ?? "Not verified — this tool hasn't been tested yet.",
  };
}

/**
 * Aggregate connection state of one integration for the current user.
 *
 * Setup comes FIRST: a tool still missing a key is `Needs a key from you`, never
 * `Not working`. Both are unhealthy, but only one names something the user can
 * act on, and a probe verdict from before the key was entered must not outrank
 * the thing actually in the way. Only once every variable is provided does the
 * question become whether what was provided works.
 *
 * `verdict` is the result of a probe the CALLER just ran and is holding, so only
 * the tool page passes one. Every other surface — the library cards, the skill
 * page's tool list — renders the untested green, because nothing there has
 * tested anything: no verdict is stored, so claiming `Connected` on a list built
 * from what is merely saved is the exact lie this module exists to stop.
 */
export function toolStatus(tool: ToolSecrets, verdict?: ProbeVerdict | null): AttentionStatus {
  let worst: AttentionStatus | null = null;
  for (const v of tool.variables) {
    const s = varStatus(v, tool.canWrite);
    if (s.state !== 'ok' && (worst === null || RANK[s.state] > RANK[worst.state])) worst = s;
  }
  return worst ?? healthStatus(tool, verdict);
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
 * the catalog by kind: a plugin owns its skills AND the tools those skills need,
 * so filtering to "just tools" would show a plugin's integrations detached from
 * the reason any of them are there. Kind is a property of a card, not a view.
 */
export type LibraryFilter =
  | { kind: 'all' }
  | { kind: 'owned' }
  | { kind: 'group'; plugin: string }
  /** Owned by someone, in no plugin — the prototype calls these "yours alone". */
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
  /** Folder plugin from the item's KB path, or null when it sits in none. */
  plugin: string | null;
  /**
   * Lives under the shared `Skills/` root rather than in a plugin folder.
   * Such an item has no folder plugin, but it is not "yours alone" either —
   * it is owned by a scope and shared into plugins by link — so the
   * ungrouped view leaves it out and only the catalog-wide view lists it.
   */
  shared?: boolean;
}

/** "Yours alone": in no plugin folder AND not a shared skill. */
export function isUngrouped(item: Pick<LibraryFilterable, 'plugin' | 'shared'>): boolean {
  return item.plugin === null && !item.shared;
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
        return item.plugin === filter.plugin;
      case 'ungrouped':
        return isUngrouped(item);
    }
  });
}

/**
 * Plugin names present in the catalog, with how many items each holds.
 *
 * Sorted by name rather than by count so the sidebar does not reorder itself
 * when a plugin gains an item — a nav that moves under the pointer is worse
 * than one that buries the biggest plugin in the middle.
 */
export function pluginCounts<T extends LibraryFilterable>(
  items: T[],
): { plugin: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.plugin === null) continue;
    counts.set(item.plugin, (counts.get(item.plugin) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([plugin, count]) => ({ plugin, count }))
    .sort((a, b) => a.plugin.localeCompare(b.plugin));
}

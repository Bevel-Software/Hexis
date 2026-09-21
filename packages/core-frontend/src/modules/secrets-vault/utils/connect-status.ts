import type {
  ConnectPending,
  ConnectTool,
  ConnectToolOAuth,
  ConnectVar,
} from '../services/connect.api';

/**
 * What the Connect page still owes, counted the way the Library counts it.
 *
 * The plugin banner counts INTEGRATIONS — one per tool whose status is not ok
 * (`attentionOf`) — and then links here. This page used to count VARIABLES, and
 * only the ones the reader could act on, so a plugin whose banner said four
 * arrived at a page showing two. Every rule below exists to close one half of
 * that gap:
 *
 *  - the unit is the TOOL, not the variable: a tool missing two keys is one
 *    integration needing setup, and a tool that appears in both sections (a
 *    sign-in AND a typed key) is still one;
 *  - a value only its owner can set counts, because the banner counts it — the
 *    reader cannot act on it, but the integration is no less unusable for that;
 *  - a SKIPPED tool counts, for the same reason. Skipping is a choice about what
 *    the agent may use, not a claim the tool is set up, and the banner has never
 *    pretended otherwise.
 *
 * Kept out of the component file deliberately: it is the half of this page that
 * has to agree with another module, so it is testable beside `attentionOf`
 * rather than only through the DOM.
 */

/**
 * What a row says when the workspace value it is waiting on belongs to somebody
 * else. The VARIABLE is the whole message — a reader who has to go and ask an
 * owner needs the name of the thing to ask for, not the news that they are
 * blocked. One function so the badge on the tool and the line on the variable
 * cannot come to word it differently.
 */
export function ownerReason(varName: string): string {
  return `Needs an owner to set ${varName}`;
}

/** A variable the caller can do something about right now. */
export function isActionable(v: ConnectVar): boolean {
  return !v.ownerOnly;
}

/**
 * Is this tool still short of something? Any variable the listing carried and
 * did not mark configured — the caller's to set or the owner's, since the
 * integration is unusable either way.
 */
export function toolNeedsSetup(tool: ConnectTool): boolean {
  return tool.variables.some((v) => !v.configured);
}

/**
 * Is this sign-in still short of something? Three ways, in the order the row
 * reads them: the provider was never registered (the owner's job), the caller
 * never signed in, or the token no longer covers what the tool declares.
 */
export function signInNeedsSetup(o: ConnectToolOAuth): boolean {
  return !o.ownerConfigured || !o.authorized || o.needsReauth;
}

/**
 * The page's outstanding count: distinct INTEGRATIONS that need something.
 *
 * Distinct by slug across both sections — a tool with an unfinished sign-in and
 * an unset key is one integration in the banner and must be one here.
 *
 * Standalone sign-ins are deliberately NOT in this number. They are registered
 * on the Secrets page rather than declared by a `.tool`, so no plugin banner has
 * ever counted one, and this number exists to equal a banner's. Adding them
 * would reintroduce the disagreement from the other side: a reader with one
 * unauthorized personal secret would see a page claiming five where the plugin
 * said four. They are still work, and still listed — see `standaloneOutstanding`.
 */
export function outstandingCount(pending: ConnectPending): number {
  const slugs = new Set<string>();
  for (const t of pending.tools) if (toolNeedsSetup(t)) slugs.add(t.slug);
  for (const o of pending.toolOAuth) if (signInNeedsSetup(o)) slugs.add(o.slug);
  return slugs.size;
}

/**
 * Standalone sign-ins still waiting on the reader — kept apart from the
 * integration count precisely because nothing else counts them, and folded back
 * in only where the page asks "is there anything left at all?" (the zero-state
 * banner). A page that said "everything is set up" over a row saying
 * "Needs sign-in" would be lying about the row right under it.
 */
export function standaloneOutstanding(pending: ConnectPending): number {
  return pending.oauth.filter((o) => !o.authorized).length;
}

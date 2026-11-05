/**
 * What was typed on the setup screen, kept across a trip to another site.
 *
 * Connecting GitHub takes the browser away, twice: once to create the app,
 * once to install it. The page that comes back is a new page, and the form
 * on it is empty. An admin who had named their branches, renamed a folder
 * or started on single sign-on before pressing "Create the GitHub App"
 * would find all of it gone, with nothing to say it had been there.
 *
 * So what was typed is kept in this tab for the length of the trip and put
 * back on return.
 *
 * SECRETS ARE NOT KEPT. An access token or an application secret typed into
 * the form lives in the page's memory and nowhere else; writing it to the
 * browser's storage would leave it readable by any script on the page and
 * lying there after the tab moved on. They are dropped, and the screen says
 * which ones to enter again, which is a smaller loss than the one this
 * exists to prevent.
 *
 * Session storage, so it is this tab's alone and goes with the tab. It is
 * good for half an hour and for one return: read once, then removed.
 */

const KEY = 'hexis_setup_draft';
const GOOD_FOR_MS = 30 * 60_000;

export interface KeptDraft {
  /** What was typed, without the secrets. */
  draft: Record<string, string>;
  /** The secrets that were typed and not kept, by setting key. */
  dropped: string[];
}

const NOTHING: KeptDraft = { draft: {}, dropped: [] };

/**
 * Keep what was typed, ahead of leaving the page. `isSecret` says which
 * settings are. Storage that refuses (a private window, a policy) keeps
 * nothing, which is where things stood before.
 */
export function keepDraft(draft: Record<string, string>, isSecret: (key: string) => boolean, now: number = Date.now()): void {
  const typed = Object.entries(draft).filter(([, value]) => value.trim() !== '');
  const kept: KeptDraft & { at: number } = {
    draft: Object.fromEntries(typed.filter(([key]) => !isSecret(key))),
    dropped: typed.filter(([key]) => isSecret(key)).map(([key]) => key),
    at: now,
  };
  try {
    if (Object.keys(kept.draft).length === 0 && kept.dropped.length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Nothing is kept.
  }
}

/**
 * What was kept, if it is still good. Reading does not remove it, so it can
 * be read while the page is being built; {@link forgetDraft} removes it
 * once the page has it. A secret is never returned, whatever the storage
 * holds: `isSecret` is asked again on the way out.
 */
export function keptDraft(isSecret: (key: string) => boolean, now: number = Date.now()): KeptDraft {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return NOTHING;
    const kept = JSON.parse(raw) as Partial<KeptDraft> & { at?: unknown };
    if (typeof kept.at !== 'number' || now - kept.at > GOOD_FOR_MS || now < kept.at) return NOTHING;
    const draft: Record<string, string> = {};
    for (const [key, value] of Object.entries(kept.draft ?? {})) {
      if (typeof value === 'string' && !isSecret(key)) draft[key] = value;
    }
    const dropped = Array.isArray(kept.dropped) ? kept.dropped.filter((key): key is string => typeof key === 'string') : [];
    return { draft, dropped };
  } catch {
    return NOTHING;
  }
}

/** Remove what was kept: the page has it, or the trip it was kept for is not the one that brought the browser here. */
export function forgetDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // There was nothing to remove from.
  }
}

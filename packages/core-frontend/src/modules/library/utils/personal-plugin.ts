/**
 * The name of a person's own space — the prototype's `MINE()`, which named
 * it after the person (`Juan's List`).
 *
 * It is called a PLUGIN here rather than a list because that is what it now is:
 * the same page, the same sections, the same card grid as `Plugins/Engineering`.
 * The only difference is which items it holds, and that is a query, not a kind.
 *
 * One name for everyone, deliberately: the page is always the reader's own,
 * so the reader's name on it adds nothing — and a sign-in record's spelling
 * of a name is not a style guide. (`displayFirstName` still greets people
 * on the welcome page.)
 */
export const PERSONAL_PLUGIN_NAME = 'Personal plugin';

export function personalPluginName(): string {
  return PERSONAL_PLUGIN_NAME;
}

/**
 * A person's first name, capitalized for display: `juan viera` → `Juan`.
 *
 * Sign-in records are not a style guide — an account created from a lowercase
 * email or a hastily typed name should still be greeted the way a person
 * writes their own name. The capital belongs HERE rather than at the call
 * site, so every greeting spells the same person the same way.
 *
 * Empty when there is no name to work with; the welcome page then says "there".
 */
export function displayFirstName(displayName: string | null | undefined): string {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return '';
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
}

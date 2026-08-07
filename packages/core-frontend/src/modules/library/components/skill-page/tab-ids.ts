/**
 * The ids tying the file tabs to the panel they control.
 *
 * Their own module rather than exports from `SkillFileTabs`: the two halves of
 * the relationship live in different files (the tablist here, the panel in
 * `SkillPage`), and a component file that also exports plain functions breaks
 * fast refresh — the repo lints for it.
 *
 * Callers pass a `baseId` from `useId()`, so two skill pages mounted at once
 * cannot mint colliding ids.
 */

/**
 * One tab — also what the panel names as its label.
 *
 * The file name is percent-encoded, and that is load-bearing rather than
 * tidiness: `aria-labelledby` holds a SPACE-SEPARATED list of IDREFs, so a
 * bundled file called `notes draft.md` would split the reference into two
 * tokens (`…-tab-notes` and `draft.md`), neither of which names anything, and
 * the panel would quietly lose its label. An `id` carrying ASCII whitespace is
 * invalid besides. KB paths with spaces are ordinary here — the markdown and
 * PDF renderers both handle them — so this is a reachable case, not a
 * hypothetical one.
 *
 * `encodeURIComponent` is injective, so two different files can never collide
 * on one id, and both sides of the relationship build their string through this
 * function, so they cannot disagree about the encoding.
 */
export const skillTabId = (baseId: string, file: string) =>
  `${baseId}-tab-${encodeURIComponent(file)}`;

/** The single panel every tab controls. */
export const skillPanelId = (baseId: string) => `${baseId}-panel`;

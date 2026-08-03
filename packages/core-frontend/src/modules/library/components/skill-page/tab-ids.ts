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

/** One tab — also what the panel names as its label. */
export const skillTabId = (baseId: string, file: string) => `${baseId}-tab-${file}`;

/** The single panel every tab controls. */
export const skillPanelId = (baseId: string) => `${baseId}-panel`;

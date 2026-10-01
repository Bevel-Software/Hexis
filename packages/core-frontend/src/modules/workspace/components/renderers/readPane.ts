/**
 * The attribute naming the element a host pane keeps mounted around a viewer —
 * see `RetryReadButton` for what it is for.
 */
const READ_PANE_ATTRIBUTE = 'data-read-pane';

/** The selector `RetryReadButton` looks the region up with. */
export const READ_PANE_SELECTOR = `[${READ_PANE_ATTRIBUTE}]`;

/**
 * Spread this onto a host pane's own container to make it that pane's read
 * region: `<div {...READ_PANE} …>`.
 *
 * One object rather than an attribute to copy, because the attribute is
 * useless without the `tabIndex`: `.focus()` only lands on an element the
 * document considers focusable, which is what `tabIndex={-1}` makes a plain
 * div (the same idiom `KbPageHeader` and `SkillPage` use for their regions).
 *
 * Its own module, not `RetryReadButton`'s, so that file keeps exporting a
 * component and nothing else — the fast-refresh rule the package lints for.
 */
export const READ_PANE = { [READ_PANE_ATTRIBUTE]: '', tabIndex: -1 };

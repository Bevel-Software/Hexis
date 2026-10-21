/**
 * The change-request module's public surface for other modules: what they
 * compose from it without reaching into its files. Today the one renderer the
 * Library's skill pages share with the change-request view — the marked
 * removed / added lines — and the line shape it draws.
 */
export { MarkedLines } from './components/MarkedLines';
export type { DiffLine } from './utils/diff';

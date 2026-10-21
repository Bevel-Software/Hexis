/**
 * The access model's public entry: what another module imports of it.
 *
 * The module is the grammar of `access.md` (how principals, roles, groups
 * and verbs are spelled), the errors a refused access is reported with, the
 * gate a change is read through, and the single-path read verdict every
 * surface shares, so a module that must hide what a person may not read asks
 * the same question the file routes ask. A consumer outside the module
 * imports from here, not from the files; the files are the module's own
 * layout and free to move. The `access` module's own files predate this
 * entry and still import the files directly — they move here as they are
 * touched.
 */
export * from './access-grammar.js';
export * from './access-errors.js';
export type { ChangeReadVerdict, ChangeTargetKind, IChangeReadGate } from './change-gate.js';
export { canReadWorkspacePath } from './kb-read-filter.js';

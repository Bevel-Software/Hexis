/**
 * The database schema of the CORE platform.
 *
 * In this package `schema.ts` is a re-export of `core-schema.ts` ONLY — the
 * enterprise tables live with the enterprise product, whose own schema file
 * imports the FK targets (`users`, `apiTokens`) from
 * `@bevel-software/platform-core-backend/schema`. Kept as a separate module (rather
 * than folding the tables in here) so module code keeps importing
 * `./schema.js` unchanged.
 */
export * from './core-schema.js';

/**
 * Pre-disk validity gate for `roles.yaml`.
 *
 * WHY this exists: `roles.yaml` is the single point of failure for the whole
 * app. The runtime resolver's `loadModel` HARD-THROWS `AccessConfigError` on a
 * parse failure, and `isAdmin` swallows that into `false` for EVERYONE — so a
 * single malformed `roles.yaml` is an app-wide, in-app-unrecoverable admin
 * lockout. The dedicated Roles & Members service already validates every
 * candidate before writing (`assertLoadable`), but the two RAW write paths do
 * not:
 *   - the human editor save  (`PUT /workspace/:id/file`)
 *   - the agent's file tools (`LockingFilesystem.writeFile` / `writeFiles`)
 *
 * Both of those let an admin (or an admin-driven agent) commit a broken file.
 * This guard plugs them: it runs the resolver's OWN parser on the candidate
 * BEFORE a byte hits disk, and refuses the write with a 422 on any error. A
 * write that passes here is loadable by `loadModel`, so the lockout becomes
 * structurally unreachable through normal edits.
 *
 * The break-glass recovery path (for a file that got broken some OTHER way —
 * a direct git push, a pre-guard commit) lives in `roles-admin.service.ts`.
 */

import type { FileContent } from '@mastra/core/workspace';
import { parseRolesYaml } from './access-grammar.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';

/** Repo-relative basename of the roles file (it lives at the KB repo root). */
export const ROLES_YAML_BASENAME = 'roles.yaml';

/**
 * A raw write whose candidate `roles.yaml` would not parse. 422 (bad input) —
 * the edit is refused and nothing is written. Carries the parser errors so the
 * editor / agent can show exactly what's wrong.
 */
export class RolesYamlInvalidError extends WorkflowDomainError {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      `roles.yaml would be invalid and was not saved: ${errors.join('; ')}`,
      422,
      { kind: 'roles-yaml-invalid', rolesYamlErrors: errors },
    );
    this.name = 'RolesYamlInvalidError';
    this.errors = errors;
  }
}

/** Normalise a workspace-relative path: backslashes → `/`, strip a leading `./`. */
function normalizeWsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True iff `workspaceRelPath` targets the KB's `roles.yaml` (the file at
 * `<kbDirName>/roles.yaml`). Both the human save route and the agent's
 * `LockingFilesystem` speak workspace-relative paths, so this is the form we
 * key on. A bare `roles.yaml` (no KB prefix) is also accepted defensively.
 */
export function isRolesYamlPath(workspaceRelPath: string, kbDirName: string): boolean {
  const norm = normalizeWsPath(workspaceRelPath);
  return norm === `${kbDirName}/${ROLES_YAML_BASENAME}` || norm === ROLES_YAML_BASENAME;
}

/**
 * Throw {@link RolesYamlInvalidError} if `content` does not parse as a valid
 * `roles.yaml` per the resolver's own parser. No-op on valid content.
 */
export function assertRolesYamlParsable(content: string): void {
  const parsed = parseRolesYaml(content);
  if (!parsed.ok) throw new RolesYamlInvalidError(parsed.errors);
}

/**
 * A `LockingFilesystem` write-validator scoped to a KB dir: refuses a raw write
 * that would leave `roles.yaml` unparseable. Pass the returned closure as the
 * filesystem's `validateWrite` hook. Only string writes are checked — every
 * code path that writes `roles.yaml` writes it as text; a binary write to that
 * path is nonsensical and left alone.
 */
export function makeRolesYamlWriteValidator(
  kbDirName: string,
): (path: string, content: FileContent) => void {
  return (path, content) => {
    if (typeof content !== 'string') return;
    if (!isRolesYamlPath(path, kbDirName)) return;
    assertRolesYamlParsable(content);
  };
}

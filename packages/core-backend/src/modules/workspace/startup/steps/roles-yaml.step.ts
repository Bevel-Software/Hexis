import fs from 'node:fs/promises';
import path from 'node:path';
import { renderRolesYaml } from '../../../access-model/render-roles-yaml.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * Write `roles.yaml` on any protected branch missing it, generated from the
 * configured seed admins (`ADMIN_EMAIL`) via the shared validated renderer
 * (../../../access-model/render-roles-yaml.ts — a malformed email stops the boot
 * with a message naming the fix). Never part of the template: a template copy
 * would seed repos with a stale hard-coded Admin list.
 *
 * An existing regular file — whatever it says — is the operator's and is left
 * alone.
 *
 * A missing file with NO admins configured is a declared `skipped`: the lazy
 * top-up warned and left the file absent, and under the startup contract that
 * survivable-but-incomplete state is the step's to declare, not to bury in a
 * log. Access resolution will fail until an Admin roles.yaml exists.
 */
export class RolesYamlStep implements OnServerStart {
  readonly name = 'roles-yaml';

  constructor(private readonly seedAdminEmails: readonly string[]) {}

  async run(ctx: ServerStartContext): Promise<StepResult> {
    const adminless: string[] = [];
    for (const branch of await ctx.protectedBranches()) {
      const repoDir = await branch.repoDir();
      // `lstat`, not `exists`: a DIRECTORY or SYMLINK squatting the name would
      // read as "present" and be skipped over — reporting success over a
      // knowledge base whose access roster cannot be read. Fail closed, same
      // as template-files' squatter checks: this is a state a human must fix.
      const found = await lstatOrNull(path.join(repoDir, 'roles.yaml'));
      if (found) {
        if (found.isFile()) continue; // the operator's file — leave it alone
        throw new Error(
          `"roles.yaml" on branch "${branch.name}" exists but is not a regular file ` +
            `(${found.isSymbolicLink() ? 'symlink' : found.isDirectory() ? 'directory' : 'special file'}). ` +
            'Remove or rename it — access loading requires this name to be a readable file at the repository root.',
        );
      }
      if (this.seedAdminEmails.length === 0) {
        adminless.push(branch.name);
        continue;
      }
      branch.write('roles.yaml', renderRolesYaml(this.seedAdminEmails));
      branch.note('Add roles.yaml granting Admin to the configured seed admins');
    }
    if (adminless.length > 0) {
      // With an empty admin list nothing was declared for ANY branch, so the
      // skip discards nothing another branch needed.
      return {
        outcome: 'skipped',
        reason:
          `roles.yaml is missing on ${adminless.join(', ')} and ADMIN_EMAIL is unset — leaving it absent. ` +
          'Access resolution will fail until an Admin roles.yaml exists; set ADMIN_EMAIL or add roles.yaml manually.',
      };
    }
    return { outcome: 'ok' };
  }
}

/** `lstat` without the throw — null when nothing is at `p`. */
async function lstatOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

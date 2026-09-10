import { comparePathComponents } from '../../shared/path-order.js';
import {
  EVERYONE_CANONICAL,
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_VERBS,
  pluginPrincipalKey,
  type AccessFile,
  type PluginTokenVerb,
  type RolesIndex,
  type Verb,
} from './access-grammar.js';

/**
 * Plugin principals — `plugin/<Name>/<verb>` — synthesised into the principal
 * index from each plugin folder's own `access.md`, so a grant naming one
 * resolves exactly like a group grant: the resolver sees a named principal
 * with member emails and needs no plugin awareness at all.
 *
 * WHAT A PLUGIN'S ROSTER IS: the folder-governing rules of
 * `Plugins/<Name>/access.md` — the file provisioning seeds and the join flow
 * edits. Three principals per plugin, following the resolver's own superset
 * convention (write implies read, owner implies both):
 *
 *   plugin/<slug>/read    everyone under read, write or owner
 *   plugin/<slug>/write   everyone under write or owner
 *   plugin/<slug>/owner   everyone under owner
 *
 * The `<slug>` is the manifest slug of the folder (`pluginManifestName`), the
 * identity `parseAccessEntry` canonicalises a hand-written token to.
 *
 * Deliberately NOT membership:
 *   - the file's frontmatter (`read: everyone` there is DISCOVERABILITY of
 *     the access.md itself, not membership) — `AccessFile.entries` already
 *     holds only the folder block;
 *   - rules inherited from above the plugin folder (the repo root's
 *     `write: Admin`) — admins reach the skill through those same rules
 *     anyway, and the roster should be what the plugin's page shows;
 *   - `deny` entries — a denial subtracts nothing here; a plugin that wants
 *     someone out removes the grant;
 *   - other plugin tokens inside a plugin's rules — skipped, so synthesis is
 *     one pass with no recursion and no cycle to detect.
 *
 * `everyone` in a plugin's own rules makes the corresponding principal
 * PUBLIC: no email list can enumerate it, so its key is recorded in
 * `index.publicKeys` and the resolver unions those into every caller's set.
 *
 * Runs AFTER groups are merged (so role and group entries expand through the
 * finished index) and BEFORE unknown-role validation (so plugin tokens in
 * access files count as known).
 */
export function synthesizePluginPrincipals(
  index: RolesIndex,
  accessFiles: ReadonlyMap<string, AccessFile>,
  /**
   * The repo-relative folders that ARE plugins — the ones carrying a
   * `plugin.json` — each with its IDENTITY (the manifest's name, or the
   * folder folded into one), as the model loader read them. A plugin is a
   * folder with a manifest, at any depth; its access.md is its roster.
   * Nothing else's is.
   */
  pluginDirs: ReadonlyMap<string, string>,
): void {
  const claimed = new Set<string>();
  // The same path order discovery walks in, so "first by path" is the same
  // plugin in both places — see `comparePathComponents`.
  for (const [dir, slug] of [...pluginDirs].sort(([a], [b]) => comparePathComponents(a, b))) {
    // Two plugins with one name: discovery keeps the first by path, so do we —
    // and the claim is made BEFORE looking for a roster, or a first plugin
    // without rules would leave its slug to a later twin's roster.
    if (claimed.has(slug)) continue;
    claimed.add(slug);
    const file = accessFiles.get(dir);
    if (!file) continue; // a plugin without rules has no roster
    for (const verb of PLUGIN_TOKEN_VERBS) {
      const { emails, everyone, sourceKeys } = holdersOf(index, file, verb);
      const key = pluginPrincipalKey(slug, verb);
      index.byCanonical.set(key, {
        displayName: key,
        emails,
        kind: 'plugin',
        pluginName: slug,
        pluginDir: dir,
        sourceKeys,
      });
      for (const email of emails) {
        let set = index.byEmail.get(email);
        if (!set) {
          set = new Set();
          index.byEmail.set(email, set);
        }
        set.add(key);
      }
      if (everyone) {
        index.publicKeys ??= new Set();
        index.publicKeys.add(key);
      }
    }
  }
}

/** The verbs whose grants confer `verb` on the plugin (the superset fold). */
function sourceVerbsFor(verb: PluginTokenVerb): Verb[] {
  switch (verb) {
    case 'read':
      return ['read', 'write', 'owner'];
    case 'write':
      return ['write', 'owner'];
    case 'owner':
      return ['owner'];
  }
}

function holdersOf(
  index: RolesIndex,
  file: AccessFile,
  verb: PluginTokenVerb,
): { emails: Set<string>; everyone: boolean; sourceKeys: Set<string> } {
  const emails = new Set<string>();
  const sourceKeys = new Set<string>();
  let everyone = false;
  for (const source of sourceVerbsFor(verb)) {
    for (const entry of file.entries[source]) {
      if (entry.deny) continue;
      if (entry.kind === 'user') {
        emails.add(entry.email);
        continue;
      }
      if (entry.role === EVERYONE_CANONICAL) {
        everyone = true;
        continue;
      }
      if (entry.role.startsWith(PLUGIN_TOKEN_PREFIX)) continue; // no recursion
      const record = index.byCanonical.get(entry.role);
      if (!record) continue; // an unknown role contributes nothing (loadModel warns separately)
      sourceKeys.add(entry.role);
      for (const email of record.emails) emails.add(email);
    }
  }
  return { emails, everyone, sourceKeys };
}
